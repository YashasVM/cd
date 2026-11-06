package `in`.yash0.cd.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import `in`.yash0.cd.Pairing
import `in`.yash0.cd.TransferView

/** Root destinations in the bottom navigation bar. */
enum class Tab { SEND, RECEIVE, TRANSFERS, DEVICES }

/** Screens pushed over the tabs. [Home] is the tab host. */
sealed interface Screen {
    data object Home: Screen
    data object Settings: Screen
    data class Transfer(val id: String): Screen
}

/** Everything the UI shows that does not come from TransferBus. MainActivity owns and refreshes it from Store. */
class UiState {
    var paused by mutableStateOf(false)
    var wakeAvailable by mutableStateOf(false)
    var pairs by mutableStateOf(emptyList<Pairing>())
    var mobile by mutableStateOf(false)
    var push by mutableStateOf(false)
    var pending by mutableStateOf<Pairing?>(null)
    var input by mutableStateOf("")
    var inputError by mutableStateOf("")
    var sendError by mutableStateOf<String?>(null)
    var tab by mutableStateOf(Tab.SEND)
    var toast by mutableStateOf<String?>(null)
    var toastSerial by mutableStateOf(0)
    val stack = mutableStateListOf<Screen>(Screen.Home)
    val screen: Screen get() = stack.last()

    fun open(screen: Screen) { if (stack.last() != screen) stack.add(screen) }
    fun back(): Boolean {
        if (stack.size > 1) { stack.removeAt(stack.lastIndex); return true }
        if (tab != Tab.SEND) { tab = Tab.SEND; return true }
        return false
    }
    fun home() { while (stack.size > 1) stack.removeAt(stack.lastIndex) }
    fun toast(text: String) { toast = text; toastSerial++ }
}

/** User intents the UI can raise. Implemented by MainActivity so platform calls stay out of composables. */
interface CdActions {
    fun pickFiles()
    fun scan()
    fun submit(raw: String)
    fun setPaused(paused: Boolean)
    fun trust(pair: Pairing)
    fun revoke(pair: Pairing)
    fun setMobile(on: Boolean)
    fun setPush(on: Boolean)
    fun pause(view: TransferView)
    fun resume(view: TransferView)
    fun cancel(view: TransferView)
    fun open(view: TransferView)
    fun dismiss(view: TransferView)
    fun copy(label: String, text: String)
    fun share(text: String)
    fun paste(): String?
    fun batterySettings()
    fun debugInject() {}
}
