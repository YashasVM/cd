package dev.yvm.cd

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

data class NearbyDevice(val endpointId: String, val name: String)

data class PendingConnection(
  val endpointId: String,
  val deviceName: String,
  val authenticationDigits: String,
)

data class PickedFile(
  val uri: Uri,
  val name: String,
  val size: Long,
  val mime: String,
)

data class FileTransferState(
  val label: String,
  val progress: Float? = null,
  val finished: Boolean = false,
  val failed: Boolean = false,
)

data class LocalTransferState(
  val localName: String,
  val searching: Boolean = false,
  val devices: List<NearbyDevice> = emptyList(),
  val pendingConnection: PendingConnection? = null,
  val connectedDevice: NearbyDevice? = null,
  val selectedFiles: List<PickedFile> = emptyList(),
  val transfer: FileTransferState? = null,
  val status: String = "Nearby is off.",
)

class NearbyTransferViewModel(application: Application) : AndroidViewModel(application) {
  private val resolver = application.contentResolver
  private val client: ConnectionsClient = Nearby.getConnectionsClient(application)
  private val serviceId = application.packageName
  private val localName = listOf(Build.MANUFACTURER, Build.MODEL).distinct().joinToString(" ").take(32)
  private val _state = MutableStateFlow(LocalTransferState(localName = localName))
  val state: StateFlow<LocalTransferState> = _state.asStateFlow()

  private val endpointNames = ConcurrentHashMap<String, String>()
  private val outgoing = ConcurrentHashMap<Long, OutgoingFile>()
  private val incoming = ConcurrentHashMap<Long, Payload>()
  private val incomingMetadata = ConcurrentHashMap<Long, IncomingFile>()
  private val completedIncoming = ConcurrentHashMap.newKeySet<Long>()
  private var active = false

  private data class OutgoingFile(val payload: Payload, val name: String)
  private data class IncomingFile(val name: String, val mime: String, val size: Long)

  private val payloadCallback =
    object : PayloadCallback() {
      override fun onPayloadReceived(endpointId: String, payload: Payload) {
        when (payload.type) {
          Payload.Type.BYTES -> payload.asBytes()?.let(::receiveManifest)
          Payload.Type.FILE -> {
            incoming[payload.id] = payload
            val name = incomingMetadata[payload.id]?.name ?: "Incoming file"
            _state.update { it.copy(transfer = FileTransferState("Receiving $name")) }
            finishIncoming(payload.id)
          }
        }
      }

      override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
        val id = update.payloadId
        val name = outgoing[id]?.name ?: incomingMetadata[id]?.name ?: "file"
        when (update.status) {
          PayloadTransferUpdate.Status.IN_PROGRESS -> {
            val progress =
              if (update.totalBytes > 0) update.bytesTransferred.toFloat() / update.totalBytes else null
            _state.update { it.copy(transfer = FileTransferState("Transferring $name", progress)) }
          }
          PayloadTransferUpdate.Status.SUCCESS -> {
            outgoing.remove(id)?.payload?.close()
            if (incoming.containsKey(id)) {
              completedIncoming += id
              finishIncoming(id)
            } else if (outgoing.isEmpty()) {
              _state.update {
                it.copy(
                  selectedFiles = emptyList(),
                  transfer = FileTransferState("Files sent", 1f, finished = true),
                  status = "Transfer complete.",
                )
              }
            }
          }
          PayloadTransferUpdate.Status.FAILURE,
          PayloadTransferUpdate.Status.CANCELED -> {
            outgoing.remove(id)?.payload?.close()
            incoming.remove(id)?.close()
            completedIncoming -= id
            incomingMetadata.remove(id)
            _state.update {
              it.copy(
                transfer = FileTransferState("Transfer interrupted", failed = true),
                status = "The transfer did not finish. Try again.",
              )
            }
          }
        }
      }
    }

  private val connectionCallback =
    object : ConnectionLifecycleCallback() {
      override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
        if (_state.value.connectedDevice != null || _state.value.pendingConnection != null) {
          client.rejectConnection(endpointId)
          return
        }
        endpointNames[endpointId] = info.endpointName
        _state.update {
          it.copy(
            pendingConnection = PendingConnection(endpointId, info.endpointName, info.authenticationDigits),
            status = "Confirm the code on both devices.",
          )
        }
        client.stopDiscovery()
      }

      override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
        when (result.status.statusCode) {
          ConnectionsStatusCodes.STATUS_OK -> {
            val device = NearbyDevice(endpointId, endpointNames[endpointId] ?: "Nearby device")
            client.stopAdvertising()
            client.stopDiscovery()
            _state.update {
              it.copy(
                searching = false,
                pendingConnection = null,
                connectedDevice = device,
                status = "Connected to ${device.name}.",
              )
            }
          }
          ConnectionsStatusCodes.STATUS_CONNECTION_REJECTED -> connectionFailed("Connection declined.")
          else -> connectionFailed("Couldn't connect to that device.")
        }
      }

      override fun onDisconnected(endpointId: String) {
        _state.update {
          it.copy(
            connectedDevice = null,
            pendingConnection = null,
            transfer = null,
            status = "Device disconnected. Looking nearby…",
          )
        }
        restartSearch()
      }
    }

  private val discoveryCallback =
    object : EndpointDiscoveryCallback() {
      override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
        endpointNames[endpointId] = info.endpointName
        _state.update { current ->
          val devices =
            (current.devices.filterNot { it.endpointId == endpointId } + NearbyDevice(endpointId, info.endpointName))
              .sortedBy { it.name.lowercase() }
          current.copy(devices = devices, status = "Choose a nearby device.")
        }
      }

      override fun onEndpointLost(endpointId: String) {
        endpointNames.remove(endpointId)
        _state.update { it.copy(devices = it.devices.filterNot { device -> device.endpointId == endpointId }) }
      }
    }

  fun start() {
    if (active) return
    active = true
    restartSearch()
  }

  fun refresh() {
    if (active) restartSearch()
  }

  fun stop() {
    active = false
    client.stopAdvertising()
    client.stopDiscovery()
    client.stopAllEndpoints()
    closePayloads()
    endpointNames.clear()
    _state.update {
      LocalTransferState(localName = localName, selectedFiles = it.selectedFiles, status = "Nearby is off.")
    }
  }

  fun connect(device: NearbyDevice) {
    if (_state.value.connectedDevice != null || _state.value.pendingConnection != null) return
    client.stopDiscovery()
    _state.update { it.copy(status = "Connecting to ${device.name}…") }
    client.requestConnection(localName, device.endpointId, connectionCallback).addOnFailureListener {
      connectionFailed("Couldn't connect to ${device.name}.")
    }
  }

  fun acceptConnection() {
    val request = _state.value.pendingConnection ?: return
    _state.update { it.copy(status = "Waiting for ${request.deviceName}…") }
    client.acceptConnection(request.endpointId, payloadCallback).addOnFailureListener {
      connectionFailed("Couldn't accept the connection.")
    }
  }

  fun declineConnection() {
    val request = _state.value.pendingConnection ?: return
    client.rejectConnection(request.endpointId)
    _state.update { it.copy(pendingConnection = null, status = "Connection declined.") }
    restartSearch()
  }

  fun selectFiles(uris: List<Uri>) {
    viewModelScope.launch(Dispatchers.IO) {
      val files = uris.mapNotNull(::readFile)
      _state.update {
        it.copy(
          selectedFiles = files,
          status = if (files.isEmpty()) "No readable files selected." else "${files.size} file(s) ready.",
        )
      }
    }
  }

  fun removeFile(uri: Uri) {
    _state.update { it.copy(selectedFiles = it.selectedFiles.filterNot { file -> file.uri == uri }) }
  }

  fun sendFiles() {
    val endpoint = _state.value.connectedDevice?.endpointId ?: return
    val files = _state.value.selectedFiles
    if (files.isEmpty()) return

    val manifest = JSONArray()
    val payloads =
      try {
        files.map { file ->
          val descriptor = resolver.openFileDescriptor(file.uri, "r") ?: error("Unreadable file")
          val payload = Payload.fromFile(descriptor)
          val name = safeName(file.name)
          payload.setFileName(name)
          payload.setParentFolder("CD")
          outgoing[payload.id] = OutgoingFile(payload, name)
          manifest.put(
            JSONObject()
              .put("id", payload.id)
              .put("name", name)
              .put("mime", file.mime)
              .put("size", file.size),
          )
          payload
        }
      } catch (_: Exception) {
        outgoing.values.forEach { it.payload.close() }
        outgoing.clear()
        _state.update {
          it.copy(
            transfer = FileTransferState("Couldn't read a selected file", failed = true),
            status = "Choose the files again.",
          )
        }
        return
      }

    val manifestPayload =
      Payload.fromBytes(
        JSONObject()
          .put("type", "manifest")
          .put("transferId", UUID.randomUUID().toString())
          .put("files", manifest)
          .toString()
          .toByteArray(StandardCharsets.UTF_8),
      )
    _state.update { it.copy(transfer = FileTransferState("Starting transfer…"), status = "Keep both devices nearby.") }
    client.sendPayload(endpoint, manifestPayload).addOnFailureListener { transferFailed() }
    payloads.forEach { payload ->
      client.sendPayload(endpoint, payload).addOnFailureListener {
        client.cancelPayload(payload.id)
        outgoing.remove(payload.id)?.payload?.close()
        transferFailed()
      }
    }
  }

  fun cancelTransfer() {
    (outgoing.keys + incoming.keys).forEach { client.cancelPayload(it) }
    _state.value.connectedDevice?.endpointId?.let(client::disconnectFromEndpoint)
    closePayloads()
    _state.update {
      it.copy(
        connectedDevice = null,
        transfer = FileTransferState("Transfer canceled", failed = true),
        status = "Transfer canceled.",
      )
    }
    restartSearch()
  }

  private fun restartSearch() {
    if (!active || _state.value.connectedDevice != null || _state.value.pendingConnection != null) return
    client.stopAdvertising()
    client.stopDiscovery()
    _state.update { it.copy(searching = true, devices = emptyList(), status = "Looking for nearby CD devices…") }
    val advertising = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
    val discovery = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build()
    client.startAdvertising(localName, serviceId, connectionCallback, advertising).addOnFailureListener {
      searchFailed("This device couldn't become visible nearby.")
    }
    client.startDiscovery(serviceId, discoveryCallback, discovery).addOnFailureListener {
      searchFailed("Nearby devices couldn't be scanned.")
    }
  }

  private fun receiveManifest(bytes: ByteArray) {
    runCatching {
      val root = JSONObject(String(bytes, StandardCharsets.UTF_8))
      if (root.optString("type") != "manifest") return
      val files = root.getJSONArray("files")
      repeat(files.length()) { index ->
        val file = files.getJSONObject(index)
        val id = file.getLong("id")
        incomingMetadata[id] =
          IncomingFile(file.getString("name"), file.optString("mime"), file.optLong("size", -1))
        finishIncoming(id)
      }
    }
  }

  private fun finishIncoming(id: Long) {
    if (id !in completedIncoming) return
    val metadata = incomingMetadata.remove(id) ?: return
    val payload = incoming.remove(id) ?: return
    completedIncoming -= id
    payload.close()
    _state.update {
      it.copy(
        transfer = FileTransferState("${metadata.name} received", 1f, finished = true),
        status = "Saved to Downloads/CD.",
      )
    }
  }

  private fun readFile(uri: Uri): PickedFile? =
    runCatching {
      runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
      var name = uri.lastPathSegment ?: "file"
      var size = -1L
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
        if (it.moveToFirst()) {
          val nameIndex = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeIndex = it.getColumnIndex(OpenableColumns.SIZE)
          if (nameIndex >= 0) name = it.getString(nameIndex) ?: name
          if (sizeIndex >= 0 && !it.isNull(sizeIndex)) size = it.getLong(sizeIndex)
        }
      }
      PickedFile(uri, safeName(name), size, resolver.getType(uri) ?: "application/octet-stream")
    }.getOrNull()

  private fun safeName(name: String) =
    name.substringAfterLast('/').substringAfterLast('\\').filterNot(Char::isISOControl).take(180).ifBlank { "file" }

  private fun searchFailed(message: String) {
    _state.update { it.copy(searching = false, status = message) }
  }

  private fun connectionFailed(message: String) {
    _state.update { it.copy(pendingConnection = null, connectedDevice = null, status = message) }
    restartSearch()
  }

  private fun transferFailed() {
    _state.update {
      it.copy(
        transfer = FileTransferState("Transfer failed", failed = true),
        status = "The file couldn't be sent. Try again.",
      )
    }
  }

  private fun closePayloads() {
    outgoing.values.forEach { it.payload.close() }
    incoming.values.forEach(Payload::close)
    outgoing.clear()
    incoming.clear()
    incomingMetadata.clear()
    completedIncoming.clear()
  }

  override fun onCleared() {
    stop()
    super.onCleared()
  }
}
