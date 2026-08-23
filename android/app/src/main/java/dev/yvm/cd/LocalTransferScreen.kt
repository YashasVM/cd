package dev.yvm.cd

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel

@Composable
internal fun LocalTransferRoute(viewModel: NearbyTransferViewModel = viewModel()) {
  val state by viewModel.state.collectAsState()
  val context = androidx.compose.ui.platform.LocalContext.current
  var permissionsGranted by remember { mutableStateOf(hasNearbyPermissions(context)) }
  var permissionDenied by remember { mutableStateOf(false) }
  val permissions = remember { nearbyPermissions() }
  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
      permissionsGranted = permissions.all { results[it] == true || ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
      permissionDenied = !permissionsGranted
      if (permissionsGranted) viewModel.start()
    }
  val filePicker =
    rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      if (uris.isNotEmpty()) viewModel.selectFiles(uris)
    }

  DisposableEffect(permissionsGranted) {
    if (permissionsGranted) viewModel.start()
    onDispose { viewModel.stop() }
  }

  LocalTransferScreen(
    state = state,
    permissionsGranted = permissionsGranted,
    permissionDenied = permissionDenied,
    onEnableNearby = { permissionLauncher.launch(permissions) },
    onRefresh = viewModel::refresh,
    onConnect = viewModel::connect,
    onAccept = viewModel::acceptConnection,
    onDecline = viewModel::declineConnection,
    onPickFiles = { filePicker.launch(arrayOf("*/*")) },
    onRemoveFile = viewModel::removeFile,
    onSend = viewModel::sendFiles,
    onCancel = viewModel::cancelTransfer,
  )
}

@Composable
private fun LocalTransferScreen(
  state: LocalTransferState,
  permissionsGranted: Boolean,
  permissionDenied: Boolean,
  onEnableNearby: () -> Unit,
  onRefresh: () -> Unit,
  onConnect: (NearbyDevice) -> Unit,
  onAccept: () -> Unit,
  onDecline: () -> Unit,
  onPickFiles: () -> Unit,
  onRemoveFile: (android.net.Uri) -> Unit,
  onSend: () -> Unit,
  onCancel: () -> Unit,
) {
  state.pendingConnection?.let { request ->
    ConnectionDialog(request, onAccept = onAccept, onDecline = onDecline)
  }

  LazyColumn(
    modifier = Modifier.fillMaxSize().background(CdBackground),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 22.dp, vertical = 24.dp),
    verticalArrangement = Arrangement.spacedBy(24.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("CD", fontSize = 24.sp, fontWeight = FontWeight.Normal, letterSpacing = (-1).sp)
        MonoLabel("LOCAL / DEVICE TO DEVICE")
      }
    }

    item {
      Column {
        Text(
          "Fast, nearby transfer.",
          fontSize = 34.sp,
          lineHeight = 38.sp,
          fontWeight = FontWeight.Normal,
          letterSpacing = (-1).sp,
        )
        Spacer(Modifier.height(12.dp))
        Text(
          "Send directly over nearby Wi-Fi and Bluetooth. No internet or account required.",
          color = CdMuted,
          fontSize = 15.sp,
          lineHeight = 23.sp,
        )
      }
    }

    if (!permissionsGranted) {
      item {
        Surface(
          color = CdRaised,
          shape = RoundedCornerShape(8.dp),
          border = androidx.compose.foundation.BorderStroke(1.dp, CdBorder),
        ) {
          Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            MonoLabel("NEARBY ACCESS")
            Text(
              if (permissionDenied) "Nearby access was declined. Enable it to discover CD devices."
              else "CD needs nearby-device access to discover and connect without using the internet.",
              color = CdTextSecondary,
              fontSize = 14.sp,
              lineHeight = 21.sp,
            )
            PrimaryButton("Enable nearby", onClick = onEnableNearby)
          }
        }
      }
    } else {
      item {
        StatusLine(
          active = state.searching || state.connectedDevice != null,
          text = "${state.status}  Visible as ${state.localName}",
        )
      }

      state.connectedDevice?.let { device ->
        item {
          Section("CONNECTED") {
            DeviceRow(device = device, connected = true, onClick = {})
          }
        }
      } ?: item {
        Section("NEARBY DEVICES", action = {
          TextButton(onClick = onRefresh, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Refresh", color = CdTextSecondary, fontSize = 13.sp)
          }
        }) {
          if (state.devices.isEmpty()) {
            Text(
              "Looking for another device running CD…",
              modifier = Modifier.padding(vertical = 18.dp),
              color = CdMuted,
              fontSize = 14.sp,
            )
          } else {
            state.devices.forEach { device -> DeviceRow(device, connected = false, onClick = { onConnect(device) }) }
          }
        }
      }

      item {
        Section("FILES", action = {
          TextButton(onClick = onPickFiles, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Add files", color = CdTextSecondary, fontSize = 13.sp)
          }
        }) {
          if (state.selectedFiles.isEmpty()) {
            OutlinedButton(
              onClick = onPickFiles,
              modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
              shape = RoundedCornerShape(8.dp),
              border = androidx.compose.foundation.BorderStroke(1.dp, CdBorder),
              colors = ButtonDefaults.outlinedButtonColors(contentColor = CdMuted),
            ) {
              Text("Choose files from this device", fontWeight = FontWeight.Normal)
            }
          } else {
            state.selectedFiles.forEachIndexed { index, file ->
              if (index > 0) HorizontalDivider(color = CdBorder)
              Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
              ) {
                MonoLabel((index + 1).toString().padStart(2, '0'))
                Column(Modifier.weight(1f)) {
                  Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                  Text(formatSize(file.size), color = CdMuted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                }
                TextButton(onClick = { onRemoveFile(file.uri) }, modifier = Modifier.heightIn(min = 48.dp)) {
                  Text("Remove", color = CdMuted, fontSize = 12.sp)
                }
              }
            }
          }
        }
      }

      state.transfer?.let { transfer ->
        item {
          Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
              Text(transfer.label, color = if (transfer.failed) Color(0xFFE5484D) else CdTextSecondary, fontSize = 13.sp)
              transfer.progress?.let { MonoLabel("${(it * 100).toInt()}%") }
            }
            transfer.progress?.let {
              LinearProgressIndicator(
                progress = { it.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(2.dp),
                color = CdText,
                trackColor = CdSurface,
              )
            }
            if (!transfer.finished && !transfer.failed) {
              TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.End).heightIn(min = 48.dp)) {
                Text("Cancel", color = CdMuted)
              }
            }
          }
        }
      }

      item {
        Button(
          onClick = onSend,
          enabled = state.connectedDevice != null && state.selectedFiles.isNotEmpty(),
          modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
          shape = RoundedCornerShape(999.dp),
          colors =
            ButtonDefaults.buttonColors(
              containerColor = CdText,
              contentColor = CdBackground,
              disabledContainerColor = CdSurface,
              disabledContentColor = CdMuted,
            ),
        ) {
          Text("Send nearby", fontWeight = FontWeight.Normal, fontSize = 14.sp)
        }
      }
    }
  }
}

@Composable
private fun Section(label: String, action: @Composable (() -> Unit)? = null, content: @Composable () -> Unit) {
  Column {
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      MonoLabel(label)
      action?.invoke()
    }
    Spacer(Modifier.height(8.dp))
    Column(
      modifier = Modifier.fillMaxWidth().border(1.dp, CdBorder, RoundedCornerShape(8.dp)).padding(horizontal = 16.dp),
    ) {
      content()
    }
  }
}

@Composable
private fun DeviceRow(device: NearbyDevice, connected: Boolean, onClick: () -> Unit) {
  TextButton(
    onClick = onClick,
    enabled = !connected,
    modifier = Modifier.fillMaxWidth().heightIn(min = 58.dp),
    colors = ButtonDefaults.textButtonColors(contentColor = CdText, disabledContentColor = CdText),
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier.size(7.dp)
          .background(if (connected) Color(0xFF3DD68C) else CdText, RoundedCornerShape(2.dp)),
      )
      Column(Modifier.padding(start = 14.dp).weight(1f), horizontalAlignment = Alignment.Start) {
        Text(device.name, fontSize = 14.sp, fontWeight = FontWeight.Normal)
        Text(
          if (connected) "READY" else "TAP TO CONNECT",
          color = CdMuted,
          fontFamily = FontFamily.Monospace,
          fontSize = 10.sp,
          letterSpacing = 1.sp,
        )
      }
      if (!connected) Text("Connect", color = CdTextSecondary, fontSize = 13.sp)
    }
  }
}

@Composable
private fun StatusLine(active: Boolean, text: String) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    Box(Modifier.size(6.dp).background(if (active) Color(0xFF3DD68C) else CdMuted, RoundedCornerShape(2.dp)))
    Text(text, color = CdMuted, fontFamily = FontFamily.Monospace, fontSize = 10.sp, lineHeight = 16.sp, letterSpacing = 0.7.sp)
  }
}

@Composable
private fun ConnectionDialog(request: PendingConnection, onAccept: () -> Unit, onDecline: () -> Unit) {
  AlertDialog(
    onDismissRequest = onDecline,
    containerColor = CdRaised,
    titleContentColor = CdText,
    textContentColor = CdTextSecondary,
    title = { Text("Connect to ${request.deviceName}?", fontWeight = FontWeight.Normal) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Confirm this code appears on both devices before accepting.", color = CdMuted, lineHeight = 21.sp)
        Text(
          request.authenticationDigits,
          fontFamily = FontFamily.Monospace,
          fontSize = 30.sp,
          letterSpacing = 4.sp,
          color = CdText,
        )
      }
    },
    confirmButton = { PrimaryButton("Accept", onClick = onAccept) },
    dismissButton = {
      TextButton(onClick = onDecline, modifier = Modifier.heightIn(min = 48.dp)) { Text("Decline", color = CdMuted) }
    },
  )
}

@Composable
private fun PrimaryButton(label: String, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier = Modifier.heightIn(min = 48.dp),
    shape = RoundedCornerShape(999.dp),
    colors = ButtonDefaults.buttonColors(containerColor = CdText, contentColor = CdBackground),
  ) {
    Text(label, fontWeight = FontWeight.Normal)
  }
}

@Composable
private fun MonoLabel(text: String) {
  Text(
    text,
    color = CdMuted,
    fontFamily = FontFamily.Monospace,
    fontSize = 10.sp,
    lineHeight = 14.sp,
    letterSpacing = 1.2.sp,
  )
}

private fun nearbyPermissions(): Array<String> =
  buildList {
    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) add(Manifest.permission.ACCESS_FINE_LOCATION)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      add(Manifest.permission.BLUETOOTH_SCAN)
      add(Manifest.permission.BLUETOOTH_ADVERTISE)
      add(Manifest.permission.BLUETOOTH_CONNECT)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.NEARBY_WIFI_DEVICES)
  }.toTypedArray()

private fun hasNearbyPermissions(context: Context) =
  nearbyPermissions().all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

private fun formatSize(bytes: Long): String =
  when {
    bytes < 0 -> "SIZE UNKNOWN"
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(bytes / 1048576.0)
  }
