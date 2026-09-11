package `in`.yash0.cd.ui.screens

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.data.TransferState
import `in`.yash0.cd.transfer.TransferViewModel
import `in`.yash0.cd.ui.components.CdCard
import `in`.yash0.cd.ui.components.CdProgress
import `in`.yash0.cd.ui.components.Kicker
import `in`.yash0.cd.ui.components.PrimaryBtn
import `in`.yash0.cd.ui.components.SecondaryBtn
import `in`.yash0.cd.ui.theme.CdType
import `in`.yash0.cd.util.formatSize
import `in`.yash0.cd.util.formatSpeed

@Composable
fun SendScreen(vm: TransferViewModel) {
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val picked by vm.picked.collectAsState()
    val code by vm.code.collectAsState()
    val qr by vm.qr.collectAsState()
    val progress by vm.progress.collectAsState()
    val state by vm.state.collectAsState()
    val status by vm.status.collectAsState()
    val error by vm.error.collectAsState()

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) {
            uris.forEach { ctx.contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            vm.setPicked(uris)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        CdCard {
            Kicker("payload")
            Text("Send a file", style = CdType.Body)
            Text("Pick anything — photos, video, docs. We mint a tiny hand-off code.", style = CdType.SmallMono)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryBtn("Choose files", onClick = { picker.launch(arrayOf("*/*")) }, modifier = Modifier.weight(1f))
                if (picked.isNotEmpty() && state == TransferState.IDLE) {
                    SecondaryBtn("Host", onClick = { vm.host() })
                }
            }
            if (picked.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                val total = picked.sumOf { it.size }
                Text(
                    if (picked.size == 1) "${picked.first().name} · ${formatSize(picked.first().size)}"
                    else "${picked.size} files · ${formatSize(total)}",
                    style = CdType.SmallMono,
                )
                Text(picked.take(3).joinToString(", ") { it.name }, style = CdType.SmallMono)
            }
        }

        if (code.isNotBlank() && (state == TransferState.WAITING || state == TransferState.TRANSFERRING)) {
            CdCard {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Kicker("share this code")
                        Text(code, style = CdType.Code)
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SecondaryBtn("Copy code", onClick = { clipboard.setText(AnnotatedString(code)) })
                            SecondaryBtn("Copy link", onClick = { clipboard.setText(AnnotatedString(vm.receiveLink)) })
                        }
                    }
                    qr?.let {
                        Image(
                            it.asImageBitmap(), contentDescription = "QR for receive link",
                            modifier = Modifier.size(140.dp).clip(RoundedCornerShape(8.dp)),
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(status, style = CdType.SmallMono)
                if (state == TransferState.TRANSFERRING) {
                    Spacer(Modifier.height(10.dp))
                    CdProgress(progress.fraction)
                    Spacer(Modifier.height(6.dp))
                    Text("${progress.percent}% · ${formatSpeed(progress.speedBps)} · ${formatSize(progress.bytes)} / ${formatSize(progress.total)}", style = CdType.SmallMono)
                    Spacer(Modifier.height(10.dp))
                    SecondaryBtn("Cancel", onClick = { vm.cancel() })
                }
            }
        }

        if (state == TransferState.COMPLETE) {
            CdCard {
                Kicker("done")
                Text("Sent. Nice.", style = CdType.Body)
                Spacer(Modifier.height(10.dp))
                PrimaryBtn("Send more stuff", onClick = { vm.reset(keepPicked = false) })
            }
        }

        error?.let {
            CdCard {
                Kicker("error")
                Text(it, style = CdType.Body)
                Spacer(Modifier.height(8.dp))
                SecondaryBtn("Try again", onClick = { vm.reset(keepPicked = true) })
            }
        }

        if (state == TransferState.IDLE && picked.isEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.width(2.dp))
                Text("Tip: you can also share straight from Files or Photos into cd.", style = CdType.SmallMono)
            }
        }
    }
}
