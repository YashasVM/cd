package `in`.yash0.cd.transfer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import `in`.yash0.cd.data.FileMeta
import `in`.yash0.cd.data.FunCodes
import `in`.yash0.cd.data.HistoryEntry
import `in`.yash0.cd.data.HistoryStore
import `in`.yash0.cd.data.Manifest
import `in`.yash0.cd.data.TransferProgress
import `in`.yash0.cd.data.TransferState
import `in`.yash0.cd.data.Wire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String)

/**
 * Owns the whole session: friendly code, PeerJS signaling, WebRTC channel,
 * chunked file IO, progress, cancel, history. UI observes the StateFlows.
 *
 * Handshake + framing verified against peerjs@1.5.5 (see PeerWire).
 */
class TransferRepository(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val saver = FileSaver(context)
    private val history = HistoryStore(context)

    private val _state = MutableStateFlow(TransferState.IDLE)
    val state: StateFlow<TransferState> = _state.asStateFlow()
    private val _code = MutableStateFlow("")
    val code: StateFlow<String> = _code.asStateFlow()
    private val _picked = MutableStateFlow<List<PickedFile>>(emptyList())
    val picked: StateFlow<List<PickedFile>> = _picked.asStateFlow()
    private val _manifest = MutableStateFlow<Manifest?>(null)
    val manifest: StateFlow<Manifest?> = _manifest.asStateFlow()
    private val _progress = MutableStateFlow(TransferProgress())
    val progress: StateFlow<TransferProgress> = _progress.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()
    private val _status = MutableStateFlow("Waiting for receiver...")
    val status: StateFlow<String> = _status.asStateFlow()

    private var signaling: PeerJsSignalingClient? = null
    private var rtc: RtcTransferManager? = null
    private var remoteId: String? = null
    private var connectionId: String? = null
    private var cancelled = false
    private var lastAckMs = 0L
    private var currentSink: FileSaver.Sink? = null
    private var hostRetries = 0

    fun setPickedUris(uris: List<Uri>) {
        _picked.value = uris.mapNotNull { resolve(it) }
        _error.value = null
    }

    private fun resolve(uri: Uri): PickedFile? {
        return try {
            var name = "file"
            var size = 0L
            context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val si = c.getColumnIndex(OpenableColumns.SIZE)
                if (c.moveToFirst()) {
                    if (ni >= 0) name = c.getString(ni) ?: name
                    if (si >= 0) size = c.getLong(si)
                }
            }
            if (size <= 0) {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { size = it.length }
            }
            val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
            PickedFile(uri, name, size.coerceAtLeast(0L), mime)
        } catch (t: Throwable) {
            null
        }
    }

    // ---------- sender ----------

    fun host() {
        reset(keepPicked = true)
        if (_picked.value.isEmpty()) {
            _error.value = "Pick at least one file first."
            return
        }
        hostRetries = 0
        hostWithFreshCode()
    }

    private fun hostWithFreshCode() {
        val c = FunCodes.generate()
        _code.value = c
        _state.value = TransferState.WAITING
        _status.value = "Waiting for receiver..."
        startStack(myId = FunCodes.peerIdFor(c), isSender = true, targetId = null)
    }

    // ---------- receiver ----------

    fun join(raw: String) {
        reset(keepPicked = false)
        val c = FunCodes.fromLinkOrCode(raw)
        if (!FunCodes.isValid(c)) {
            _error.value = "That code is a dud."
            _state.value = TransferState.FAILED
            return
        }
        _code.value = c
        _state.value = TransferState.CONNECTING
        _status.value = "Finding the sender..."
        val myId = "cd-r-" + UUID.randomUUID().toString().replace("-", "").take(8)
        startStack(myId = myId, isSender = false, targetId = FunCodes.peerIdFor(c))
    }

    private fun startStack(myId: String, isSender: Boolean, targetId: String?) {
        cancelled = false
        connectionId = PeerWire.newConnectionId()
        val cid = connectionId!!
        Log.d(TAG, "startStack myId=$myId sender=$isSender target=$targetId cid=$cid")
        val manager = RtcTransferManager(
            context = context,
            onFrame = { handleFrame(it) },
            onConnected = {
                scope.launch {
                    _status.value = if (isSender) "Receiver found." else "Connected."
                    if (isSender) sendAll()
                }
            },
            onDisconnected = {
                scope.launch {
                    if (_state.value != TransferState.COMPLETE && !cancelled) {
                        _error.value = "Connection vanished."
                        _state.value = TransferState.FAILED
                    }
                }
            },
        )
        rtc = manager
        manager.setIceEmitter { ice ->
            val dst = if (isSender) remoteId else targetId
            dst?.let { signaling?.sendCandidate(it, cid, ice.sdp, ice.sdpMid, ice.sdpMLineIndex) }
        }
        signaling = PeerJsSignalingClient(
            myId = myId,
            onOpen = {
                scope.launch {
                    if (!isSender && targetId != null) {
                        _status.value = "Finding the sender..."
                        manager.createOffer(
                            label = cid,
                            onSdp = { _, sdp -> signaling?.sendOffer(targetId, cid, sdp, cid) },
                            onFailure = { fail(it) },
                        )
                    }
                }
            },
            onOffer = { ev ->
                // Sender side: the browser/app receiver dials us.
                if (!isSender) return@PeerJsSignalingClient
                remoteId = ev.from
                connectionId = ev.connectionId
                scope.launch {
                    manager.createAnswer(
                        ev.sdp,
                        onSdp = { _, sdp -> signaling?.sendAnswer(ev.from, ev.connectionId, sdp) },
                        onFailure = { fail(it) },
                    )
                }
            },
            onAnswer = { ev ->
                if (ev.connectionId != connectionId) return@PeerJsSignalingClient
                manager.acceptAnswer(ev.sdp)
            },
            onCandidate = { ev ->
                if (ev.connectionId != connectionId) return@PeerJsSignalingClient
                manager.addRemoteCandidate(ev.candidate, ev.sdpMid, ev.sdpMLineIndex)
            },
            onIdTaken = {
                scope.launch {
                    // Mirror web: colliding code -> mint a fresh one and re-host.
                    if (isSender && hostRetries < 5) {
                        hostRetries++
                        reset(keepPicked = true)
                        hostWithFreshCode()
                    } else {
                        fail("Code collision. Try again.")
                    }
                }
            },
            onPeerGone = { fail("Bad code, or the sender wandered off.") },
            onError = { fail(it) },
        )
        signaling?.connect()
        scope.launch {
            delay(TransferProtocol.CONNECTION_TIMEOUT_MS)
            if (!manager.isConnected &&
                (_state.value == TransferState.WAITING || _state.value == TransferState.CONNECTING)
            ) {
                // Senders keep waiting (a receiver may arrive later, and the
                // heartbeat keeps the registration alive); receivers time out.
                if (!isSender) fail("Connection timed out. Check the code and try again.")
            }
        }
    }

    // ---------- sending ----------

    private suspend fun sendAll() {
        val files = _picked.value
        if (files.isEmpty()) return
        val metas = files.mapIndexed { i, f -> FileMeta(i, f.name, f.size, f.mime) }
        val total = metas.sumOf { it.size }
        _manifest.value = Manifest(files.size, total, metas)
        _progress.value = TransferProgress(0, total, System.currentTimeMillis())
        _state.value = TransferState.TRANSFERRING
        rtc?.sendControl(PeerWire.manifestMap(_manifest.value!!))
        var sent = 0L
        for ((i, f) in files.withIndex()) {
            if (cancelled) return
            _status.value = "Sending ${i + 1} of ${files.size}…"
            rtc?.sendControl(PeerWire.fileStartMap(i))
            try {
                context.contentResolver.openInputStream(f.uri)?.use { input ->
                    val buf = ByteArray(TransferProtocol.CHUNK_SIZE)
                    while (!cancelled) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        while (rtc?.bufferedAmount() ?: 0L > TransferProtocol.BUFFER_LOW_AMOUNT && !cancelled) {
                            delay(16)
                        }
                        if (cancelled) return
                        if (rtc?.sendFileBytes(buf, 0, n) == false) delay(16)
                        sent += n
                    }
                }
            } catch (t: Throwable) {
                fail("Could not read ${f.name}."); return
            }
            if (cancelled) return
            rtc?.sendControl(PeerWire.fileCompleteMap(i))
        }
        rtc?.sendControl(PeerWire.transferCompleteMap())
        scope.launch {
            delay(8000)
            if (!cancelled && _state.value == TransferState.TRANSFERRING) finishSend()
        }
    }

    // ---------- receiving ----------

    private fun handleFrame(frame: PeerFrame) {
        scope.launch {
            when (frame) {
                is PeerFrame.Bytes -> handleFileBytes(frame.bytes)
                is PeerFrame.Control -> handleControl(frame.fields)
            }
        }
    }

    private suspend fun handleControl(map: Map<String, Any?>) {
        Log.d(TAG, "ctrl<< ${PeerWire.controlType(map)}")
        when (PeerWire.controlType(map)) {
            Wire.MANIFEST -> {
                val m = PeerWire.parseManifest(map) ?: return
                _manifest.value = m
                _progress.value = TransferProgress(0, m.totalSize, System.currentTimeMillis())
                _state.value = TransferState.TRANSFERRING
                _status.value = "Receiving…"
            }
            Wire.FILE_START -> {
                val index = PeerWire.fileIndex(map)
                val meta = _manifest.value?.files?.getOrNull(index)
                runCatching { currentSink?.stream?.close() }
                currentSink = if (meta != null) runCatching { saver.open(meta.name, meta.mimeType) }.getOrNull() else null
                _state.value = TransferState.SAVING
            }
            Wire.FILE_COMPLETE -> {
                runCatching { currentSink?.stream?.close() }
                currentSink = null
                ackProgress(force = true)
            }
            Wire.TRANSFER_COMPLETE -> {
                runCatching { currentSink?.stream?.close() }
                currentSink = null
                rtc?.sendControl(PeerWire.transferAckMap())
                finishReceive()
            }
            Wire.TRANSFER_ACK -> finishSend()
            Wire.PROGRESS -> {
                val m = _manifest.value ?: return
                val b = PeerWire.progressBytes(map).coerceAtMost(m.totalSize)
                _progress.value = _progress.value.copy(bytes = maxOf(_progress.value.bytes, b))
            }
            Wire.CANCEL -> {
                cancelled = true
                _error.value = "The other side canceled the transfer."
                _state.value = TransferState.FAILED
            }
            else -> Unit
        }
    }

    private suspend fun handleFileBytes(bytes: ByteArray) {
        val m = _manifest.value ?: return
        try {
            currentSink?.stream?.write(bytes)
        } catch (t: Throwable) {
            fail("Could not save file."); return
        }
        val now = _progress.value.bytes + bytes.size
        _progress.value = _progress.value.copy(bytes = now.coerceAtMost(m.totalSize))
        ackProgress(force = false)
    }

    private fun ackProgress(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - lastAckMs < 120) return
        lastAckMs = now
        rtc?.sendControl(PeerWire.progressMap(_progress.value.bytes))
    }

    private suspend fun finishSend() {
        if (_state.value == TransferState.COMPLETE || cancelled) return
        val m = _manifest.value
        _progress.value = _progress.value.copy(bytes = _progress.value.total)
        _state.value = TransferState.COMPLETE
        _status.value = "Sent."
        if (m != null) {
            history.add(HistoryEntry(direction = "sent", title = if (m.totalFiles == 1) m.files.first().name else "${m.totalFiles} files", detail = "${m.totalFiles} file(s)"))
        }
        closeStack()
    }

    private suspend fun finishReceive() {
        if (_state.value == TransferState.COMPLETE || cancelled) return
        val m = _manifest.value
        _progress.value = _progress.value.copy(bytes = _progress.value.total)
        _state.value = TransferState.COMPLETE
        _status.value = "All here."
        if (m != null) {
            history.add(HistoryEntry(direction = "received", title = if (m.totalFiles == 1) m.files.first().name else "${m.totalFiles} files", detail = "Saved to Downloads/cd"))
        }
        closeStack()
    }

    /** Tear down signaling + peer connection after a finished transfer; keeps UI state. */
    private fun closeStack() {
        runCatching { signaling?.close() }
        runCatching { rtc?.close() }
        runCatching { currentSink?.stream?.close() }
        signaling = null
        rtc = null
        currentSink = null
        remoteId = null
    }

    private fun fail(message: String) {
        scope.launch {
            if (_state.value == TransferState.COMPLETE) return@launch
            _error.value = message
            _state.value = TransferState.FAILED
        }
    }

    fun cancel() {
        scope.launch {
            if (cancelled) return@launch
            cancelled = true
            runCatching { rtc?.sendControl(PeerWire.cancelMap()) }
            runCatching { currentSink?.stream?.close() }
            reset(keepPicked = true)
        }
    }

    fun reset(keepPicked: Boolean = false) {
        cancelled = true
        runCatching { signaling?.close() }
        runCatching { rtc?.close() }
        runCatching { currentSink?.stream?.close() }
        signaling = null
        rtc = null
        currentSink = null
        remoteId = null
        connectionId = null
        cancelled = false
        if (!keepPicked) _picked.value = emptyList()
        _manifest.value = null
        _progress.value = TransferProgress()
        _error.value = null
        _status.value = "Waiting for receiver..."
        _state.value = TransferState.IDLE
    }

    companion object {
        private const val TAG = "cd-repo"
    }
}
