package `in`.yash0.cd.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.TransferView
import kotlinx.coroutines.delay

@Composable
fun CdApp(state: UiState, transfers: List<TransferView>, status: String, actions: CdActions, debug: Boolean, version: String) {
    BackHandler(state.stack.size > 1 || state.tab != Tab.SEND) { state.back() }
    val activeCount = transfers.count { it.active }
    val chrome = remember(state, actions, debug) {
        TabChrome(
            brand = { BrandMark { if (debug) actions.debugInject() } },
            actions = { IconAction(CdIcons.Settings, "Settings", { state.open(Screen.Settings) }) },
            bottomBar = { BottomNav(state.tab, activeCountHolder.intValue, { state.tab = it }) },
        )
    }
    activeCountHolder.intValue = activeCount
    Box(Modifier.fillMaxSize().background(Cd.bg)) {
        AmbientBackground(height = 300.dp)
        AnimatedContent(
            targetState = state.screen to state.stack.size,
            transitionSpec = {
                val forward = targetState.second >= initialState.second
                val dir = if (forward) 1 else -1
                (fadeIn(tween(280, 40, EaseOutSoft)) + slideInHorizontally(tween(360, easing = EaseOutSoft)) { dir * it / 5 })
                    .togetherWith(fadeOut(tween(160)) + slideOutHorizontally(tween(360, easing = EaseOutSoft)) { -dir * it / 10 })
            },
            contentKey = { it.first },
            label = "screen",
        ) { (screen, _) ->
            when (screen) {
                Screen.Home -> AnimatedContent(state.tab, transitionSpec = { fadeIn(tween(220, 60)).togetherWith(fadeOut(tween(120))) }, label = "tab") { tab ->
                    when (tab) {
                        Tab.SEND -> SendTab(state, transfers, actions, chrome)
                        Tab.RECEIVE -> ReceiveTab(state, status, actions, chrome)
                        Tab.TRANSFERS -> TransfersTab(state, transfers, chrome)
                        Tab.DEVICES -> DevicesTab(state, actions, chrome)
                    }
                }
                Screen.Settings -> SettingsScreen(state, actions, version, debug)
                is Screen.Transfer -> TransferScreen(screen.id, transfers, actions) { state.back() }
            }
        }
        Toast(state, Modifier.align(Alignment.TopCenter))
    }
    state.pending?.let { pair ->
        CdDialog(
            title = "Trust ${pair.name}?",
            body = "This laptop will be able to send files straight to Downloads/CD on this phone. Confirm that you scanned the QR shown by your own laptop. You can revoke access at any time.",
            detail = "device ${pair.id.take(8)}",
            confirm = "Trust device", icon = CdIcons.Shield,
            onConfirm = { actions.trust(pair) }, onDismiss = { state.pending = null },
        )
    }
}

/** Read by the remembered bottom bar so the badge updates without rebuilding the tab chrome. */
private val activeCountHolder = mutableIntStateOf(0)

/** Snackbar-style confirmation under the app bar, clear of the pinned buttons and the keyboard. */
@Composable
private fun Toast(state: UiState, modifier: Modifier) {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(state.toastSerial) { if (state.toast != null) { visible = true; delay(1800); visible = false } }
    AnimatedVisibility(visible, modifier.statusBarsPadding().padding(top = 72.dp),
        enter = fadeIn(tween(220)) + slideInVertically(tween(320, easing = EaseOutSoft)) { -it / 2 } + scaleIn(tween(320, easing = EaseOutSoft), 0.92f),
        exit = fadeOut(tween(200)) + slideOutVertically(tween(240)) { -it / 3 }) {
        Row(
            Modifier.padding(horizontal = Gutter).clip(RoundedCornerShape(14.dp)).background(Cd.workbenchTab).border(1.dp, Cd.success.copy(alpha = 0.45f), RoundedCornerShape(14.dp)).padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(CdIcons.Check, null, Modifier.size(18.dp), tint = Cd.success)
            Text(state.toast.orEmpty(), style = CdType.body)
        }
    }
}
