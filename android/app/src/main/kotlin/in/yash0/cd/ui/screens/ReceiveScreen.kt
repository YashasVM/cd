package `in`.yash0.cd.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.data.FunCodes
import `in`.yash0.cd.data.TransferState
import `in`.yash0.cd.transfer.TransferViewModel
import `in`.yash0.cd.ui.components.CdCard
import `in`.yash0.cd.ui.components.CdProgress
import `in`.yash0.cd.ui.components.Kicker
import `in`.yash0.cd.ui.components.PrimaryBtn
import `in`.yash0.cd.ui.components.SecondaryBtn
import `in`.yash0.cd.ui.theme.CdColors
import `in`.yash0.cd.ui.theme.CdType
import `in`.yash0.cd.util.formatSize
import `in`.yash0.cd.util.formatSpeed

@Composable
fun ReceiveScreen(vm: TransferViewModel, onScan: () -> Unit) {
    val state by vm.state.collectAsState()
    val progress by vm.progress.collectAsState()
    val manifest by vm.manifest.collectAsState()
    val error by vm.error.collectAsState()
    val code by vm.code.collectAsState()
    var input by remember { mutableStateOf(FunCodes.clean(code)) }

    // Mirror codes that arrive from deep links / scanner.
    LaunchedEffect(code) {
        val clean = FunCodes.clean(code)
        if (FunCodes.isValid(clean) && clean != input) input = clean
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (state == TransferState.IDLE || state == TransferState.FAILED) {
            CdCard {
                Kicker("enter the hand-off word")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = FunCodes.clean(it) },
                        placeholder = { Text("waffle") },
                        singleLine = true,
                        textStyle = CdType.Code.copy(fontSize = androidx.compose.ui.unit.TextUnit.Unspecified),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = CdColors.Accent,
                            unfocusedBorderColor = CdColors.Line,
                            focusedTextColor = CdColors.Text,
                            unfocusedTextColor = CdColors.Text,
                            cursorColor = CdColors.Accent,
                        ),
                        modifier = Modifier.weight(1f),
                    )
                    PrimaryBtn("Connect", onClick = { vm.join(input) })
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryBtn("Scan code", onClick = onScan)
                    if (error != null) SecondaryBtn("Try again", onClick = { vm.reset() })
                }
                Text("Camera optional. Typing still works.", style = CdType.SmallMono)
            }
        }

        if (state == TransferState.CONNECTING) {
            CdCard {
                Kicker("connecting")
                Text("Finding the sender...", style = CdType.Body)
                Spacer(Modifier.height(8.dp))
                SecondaryBtn("Cancel", onClick = { vm.reset() })
            }
        }

        if (state == TransferState.TRANSFERRING || state == TransferState.SAVING) {
            manifest?.let { m ->
                CdCard {
                    Kicker("incoming stuff")
                    Text(
                        if (m.totalFiles == 1) m.files.first().name else "${m.totalFiles} files incoming",
                        style = CdType.Body,
                    )
                    Text(formatSize(m.totalSize), style = CdType.SmallMono)
                    Spacer(Modifier.height(10.dp))
                    CdProgress(progress.fraction, modifier = Modifier.fillMaxWidth())
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
                Text("All here. Saved to Downloads/cd.", style = CdType.Body)
                Spacer(Modifier.height(10.dp))
                PrimaryBtn("Grab more stuff", onClick = { vm.reset() })
            }
        }

        error?.let {
            if (state == TransferState.FAILED) {
                CdCard {
                    Kicker("couldn't connect")
                    Text(it, style = CdType.Body.copy(color = CdColors.ErrorText))
                }
            }
        }
    }
}
