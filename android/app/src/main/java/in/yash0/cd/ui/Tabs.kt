package `in`.yash0.cd.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import `in`.yash0.cd.Direction
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.PushBridge
import `in`.yash0.cd.TransferView

/* ---------- Send ---------- */

@Composable
fun SendTab(state: UiState, transfers: List<TransferView>, actions: CdActions, chrome: TabChrome) {
    val sends = transfers.filter { it.direction == Direction.SEND }
    ScreenFrame(
        "Send", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = { PrimaryButton(if (state.sendError != null) "Try again" else "Choose files", { state.sendError = null; actions.pickFiles() }, Modifier.fillMaxWidth(), icon = CdIcons.Upload) },
    ) {
        val error = state.sendError
        if (error != null) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Cd.panel).border(1.dp, Cd.danger.copy(alpha = 0.35f), RoundedCornerShape(18.dp)).padding(18.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                ResultMark(CdIcons.Close, Tone.DANGER, size = 44.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("That didn’t work", style = CdType.rowTitle)
                    Text(error, style = CdType.small.copy(color = Cd.dangerText))
                    Text("Dismiss", Modifier.padding(top = 6.dp).clip(RoundedCornerShape(6.dp)).clickable { state.sendError = null }.padding(vertical = 8.dp), style = CdType.label.copy(color = Cd.accent))
                }
            }
            Spacer(Modifier.height(24.dp))
        }
        Hero(CdIcons.Upload, "Choose files to send")
        if (sends.isNotEmpty()) {
            Spacer(Modifier.height(24.dp))
            SectionHeader("Your sends")
            TransferGroup(sends, state, actions)
        }
    }
}

@Composable
private fun Hero(icon: ImageVector, title: String) {
    Column(Modifier.fillMaxWidth().enter(), horizontalAlignment = Alignment.Start) {
        Box(
            Modifier.size(72.dp).clip(CircleShape)
                .background(Brush.radialGradient(listOf(Cd.accent.copy(alpha = 0.24f), Cd.accent.copy(alpha = 0.04f))))
                .border(1.dp, Cd.accent.copy(alpha = 0.4f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, Modifier.size(30.dp), tint = Cd.accent) }
        Spacer(Modifier.height(24.dp))
        Text(title, style = CdType.title)
    }
}

/* ---------- Receive ---------- */

@Composable
fun ReceiveTab(state: UiState, transfers: List<TransferView>, status: String, actions: CdActions, chrome: TabChrome) {
    ScreenFrame(
        "Receive", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton("Scan QR", { actions.scan() }, Modifier.weight(1f), icon = CdIcons.Scan)
                PrimaryButton(if (state.input.trim().startsWith("cdpair:")) "Review" else "Receive", { actions.submit(state.input.trim()) }, Modifier.weight(1f), enabled = state.input.isNotBlank())
            }
        },
    ) {
        InkField(
            state.input, { state.input = it; state.inputError = "" }, "Enter a code or paste a link", error = state.inputError.isNotEmpty(),
            onGo = { if (state.input.isNotBlank()) actions.submit(state.input.trim()) }, description = "Code or link",
            trailing = {
                if (state.input.isEmpty()) GhostButton("Paste", { actions.paste()?.let { state.input = it; state.inputError = "" } }, icon = CdIcons.Paste, color = Cd.accent)
                else IconAction(CdIcons.Close, "Clear", { state.input = ""; state.inputError = "" }, tint = Cd.faint)
            },
        )
        AnimatedVisibility(state.inputError.isNotEmpty()) { Text(state.inputError, Modifier.padding(top = 10.dp), style = CdType.small.copy(color = Cd.danger)) }

        Spacer(Modifier.height(24.dp))
        GhostButton("Choose QR image", { actions.importQr() }, icon = CdIcons.File)
        Spacer(Modifier.height(16.dp))
        SectionHeader("Received files")
        val received = transfers.filter { it.direction == Direction.RECEIVE }
        if (received.isEmpty()) Text("No received files yet.", style = CdType.small)
        else TransferGroup(received, state, actions)
    }
}

/** The legacy receiver posts idle lines ("Ready to receive", "Receiving is off"); only real activity is worth showing. */
private fun liveStatus(status: String): String? = status.takeIf { it.isNotBlank() && it !in setOf("Receiving is off", "Ready to receive", "Receiving stopped") }

@Composable
fun TransferGroup(list: List<TransferView>, state: UiState, actions: CdActions) {
    Group {
        list.forEachIndexed { i, view ->
            if (i > 0) RowDivider()
            TransferRow(view, {
                if (view.direction == Direction.RECEIVE && view.phase == `in`.yash0.cd.TransferPhase.COMPLETE) actions.open(view)
                else state.open(Screen.Transfer(view.id))
            })
        }
    }
}

/** Empty state: the website's identity lives here instead of on every screen. */
@Composable
fun EmptyBrand(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(top = 40.dp).enter(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("cd", style = CdType.brandLarge)
            Text("/di·rect/", Modifier.padding(bottom = 8.dp), style = CdType.kicker.copy(fontSize = 13.sp))
        }
        Spacer(Modifier.height(16.dp))
        Text("Direct phone-to-terminal file transfer.", style = CdType.body.copy(color = Cd.muted), textAlign = TextAlign.Center)
        Spacer(Modifier.height(40.dp))
        Text(title, style = CdType.title, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(body, style = CdType.bodyMuted, textAlign = TextAlign.Center)
    }
}

/* ---------- Devices ---------- */

@Composable
fun DevicesTab(state: UiState, actions: CdActions, chrome: TabChrome) {
    var revoking by remember { mutableStateOf<Pairing?>(null) }
    ScreenFrame(
        "Devices", navigation = chrome.brand, actions = chrome.actions, bottomBar = chrome.bottomBar,
        pinned = {
            SecondaryButton("Choose QR image", { actions.importQr() }, Modifier.fillMaxWidth(), icon = CdIcons.File)
            PrimaryButton("Scan pairing QR", { actions.scan() }, Modifier.fillMaxWidth(), icon = CdIcons.Scan)
        },
    ) {
        ListRow("cdx pair", "Run on your PC", icon = CdIcons.Terminal, onClick = { actions.copy("Pair command", "cdx pair") })
        Spacer(Modifier.height(16.dp))
        SectionHeader(if (state.pairs.isEmpty()) "Trusted" else "Trusted · ${state.pairs.size}")
        if (state.pairs.isEmpty()) {
            Text("No trusted devices yet.", Modifier.padding(vertical = 8.dp), style = CdType.body.copy(color = Cd.faint))
        } else Group {
            state.pairs.forEachIndexed { i, pair ->
                if (i > 0) RowDivider()
                ListRow(pair.name, null, icon = CdIcons.Laptop, trailing = {
                    Text("Revoke", Modifier.clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button) { revoking = pair }.padding(horizontal = 12.dp, vertical = 12.dp), style = CdType.label.copy(color = Cd.danger))
                })
            }
        }
        Spacer(Modifier.height(24.dp))
        SectionHeader("How to pair")
        listOf("Run cdx pair on your PC", "Scan the QR code", "Tap Trust").forEachIndexed { i, step ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.size(32.dp).clip(CircleShape).border(1.dp, Cd.accent.copy(alpha = 0.45f), CircleShape), contentAlignment = Alignment.Center) {
                    Text("${i + 1}", style = CdType.label.copy(color = Cd.accent, fontSize = 15.sp))
                }
                Text(step, style = CdType.body)
            }
        }
    }
    revoking?.let { pair ->
        CdDialog(
            title = "Revoke ${pair.name}?", body = "It will no longer be able to send to this phone. Pair again with cdx pair to restore it.",
            confirm = "Revoke", danger = true, onConfirm = { actions.revoke(pair); revoking = null }, onDismiss = { revoking = null },
        )
    }
}

/* ---------- Settings ---------- */

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SettingsScreen(state: UiState, actions: CdActions, version: String, debug: Boolean) {
    ScreenFrame("Settings", navigation = { BackButton { state.back() } }) {
        SectionHeader("Receiving")
        Group {
            SwitchListRow("Pause receiving", "Stop incoming transfers.", state.paused, { actions.setPaused(it) }, CdIcons.Pause)
            if (PushBridge.available) {
                RowDivider()
                SwitchListRow("Wake-up notifications", PushBridge.status, state.push, { actions.setPush(it) }, CdIcons.Bell)
            }
            RowDivider()
            SwitchListRow("Use mobile data", "Receive over mobile data.", state.mobile, { actions.setMobile(it) }, CdIcons.Signal)
        }
        Spacer(Modifier.height(24.dp))
        SectionHeader("Battery")
        Group {
            ListRow("Battery settings", "Allow background receiving.", icon = CdIcons.Battery, onClick = { actions.batterySettings() },
                trailing = { Icon(CdIcons.Open, null, Modifier.size(20.dp), tint = Cd.faint) })
        }
        Spacer(Modifier.height(24.dp))
        SectionHeader("Get the cdx CLI")
        val cmd = "curl -fsSL https://cd.yash0.in/install.sh | sh"
        Group {
            ListRow(cmd, "Tap to copy", icon = CdIcons.Terminal, titleStyle = CdType.mono.copy(fontSize = 14.sp), titleLines = 1, onClick = { actions.copy("Install command", cmd) },
                trailing = { Icon(CdIcons.Copy, null, Modifier.size(20.dp), tint = Cd.faint) })
        }
        Spacer(Modifier.height(40.dp))
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(
                Modifier.combinedClickable(onClick = {}, onLongClick = { if (debug) actions.debugInject() }, indication = null, interactionSource = null),
                verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("cd", style = CdType.brand.copy(fontSize = 40.sp, lineHeight = 40.sp))
                Text("/di·rect/", Modifier.padding(bottom = 5.dp), style = CdType.kicker)
            }
            Spacer(Modifier.height(8.dp))
            Text("Version $version · cd.yash0.in", style = CdType.small.copy(color = Cd.faint))
        }
    }
}

@Composable
fun SwitchListRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit, icon: ImageVector) {
    val haptics = rememberHaptics()
    ListRow(
        title, detail, icon = icon, iconTint = if (checked) Cd.accent else Cd.faint,
        modifier = Modifier.toggleable(checked, role = Role.Switch) { haptics.tick(); onChange(it) },
        trailing = { CdSwitch(checked, onChange) },
    )
}

/* ---------- dialog ---------- */

@Composable
fun CdDialog(title: String, body: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, danger: Boolean = false, detail: String? = null, icon: ImageVector? = null) {
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.padding(Gutter).fillMaxWidth().enter().clip(RoundedCornerShape(24.dp)).background(Cd.workbench)
                .border(1.dp, Cd.lineSoft, RoundedCornerShape(24.dp)).padding(24.dp),
        ) {
            if (icon != null) { IconTile(icon, size = 52.dp); Spacer(Modifier.height(20.dp)) }
            Text(title, style = CdType.title, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(10.dp))
            Text(body, style = CdType.bodyMuted)
            if (detail != null) { Spacer(Modifier.height(14.dp)); StatusNote(detail) }
            Spacer(Modifier.height(24.dp))
            if (danger) SecondaryButton(confirm, onConfirm, Modifier.fillMaxWidth(), danger = true, highlighted = true)
            else PrimaryButton(confirm, onConfirm, Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            SecondaryButton("Cancel", onDismiss, Modifier.fillMaxWidth())
        }
    }
}

/** Shared top-bar and bottom-bar slots for the three root tabs. */
class TabChrome(
    val brand: @Composable () -> Unit,
    val actions: @Composable RowScope.() -> Unit,
    val bottomBar: @Composable () -> Unit,
)
