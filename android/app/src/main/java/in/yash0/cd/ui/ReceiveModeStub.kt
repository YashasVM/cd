package `in`.yash0.cd.ui

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import `in`.yash0.cd.ReceiveActivation
import `in`.yash0.cd.PushBridge
import `in`.yash0.cd.ReceiverService
import `in`.yash0.cd.StoreRegistry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Foreground activation for the existing receiver service. Explicit Pause/Stop stays paused.
 * The service currently keeps its visible notification while trusted receiving is enabled.
 */
object ReceiveMode {
    private val _wake = MutableStateFlow(PushBridge.available)
    val wakeAvailable: StateFlow<Boolean> = _wake.asStateFlow()
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused.asStateFlow()

    fun load(context: Context) {
        _paused.value = context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).getBoolean("receivePaused", false)
    }

    fun recordPaused(context: Context, paused: Boolean) {
        context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).edit().putBoolean("receivePaused", paused).apply()
        _paused.value = paused
    }

    fun setPaused(context: Context, paused: Boolean) {
        recordPaused(context, paused)
        // Stop a running receiver so paused transfers keep their progress.
        if (paused && StoreRegistry.get(context).enabled()) context.startService(Intent(context, ReceiverService::class.java).setAction("pause"))
        if (!paused) onForeground(context)
    }

    /** Start the foreground service only from a visible Activity or another permitted entry point. */
    fun startTransfer(context: Context) {
        if (_paused.value) return
        StoreRegistry.get(context).enabled(true)
        ContextCompat.startForegroundService(context, Intent(context, ReceiverService::class.java))
    }

    fun onForeground(context: Context) {
        val store = StoreRegistry.get(context)
        if (ReceiveActivation.shouldStart(_paused.value, store.pairs().isNotEmpty(), store.tasks().any { it.optString("state") == "queued" })) {
            startTransfer(context)
        }
    }
    fun onBackground(context: Context) {}
}
