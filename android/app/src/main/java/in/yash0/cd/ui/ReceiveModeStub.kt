package `in`.yash0.cd.ui

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import `in`.yash0.cd.PushBridge
import `in`.yash0.cd.ReceiverService
import `in`.yash0.cd.StoreRegistry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object ReceiveMode {
    private val _wake = MutableStateFlow(PushBridge.available)
    val wakeAvailable: StateFlow<Boolean> = _wake.asStateFlow()
    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> = _paused.asStateFlow()

    fun load(context: Context) {
        _paused.value = context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).getBoolean("receivePaused", false)
    }

    fun setPaused(context: Context, paused: Boolean) {
        recordPause(context, paused)
        // Legacy backend: stop a running receiver so paused transfers keep their progress.
        if (paused && StoreRegistry.get(context).enabled()) context.startService(Intent(context, ReceiverService::class.java).setAction("pause"))
        else if (!paused) onForeground(context)
    }

    private fun recordPause(context: Context, paused: Boolean) {
        context.getSharedPreferences("cd-ui", Context.MODE_PRIVATE).edit().putBoolean("receivePaused", paused).apply()
        _paused.value = paused
    }

    fun stopped(context: Context) { recordPause(context, true) }

    /** Trusted receiving keeps a foreground notification while it is enabled. */
    fun startTransfer(context: Context) {
        if (_paused.value) return
        StoreRegistry.get(context).enabled(true)
        ContextCompat.startForegroundService(context, Intent(context, ReceiverService::class.java))
    }

    fun onForeground(context: Context) {
        if (!_paused.value && StoreRegistry.get(context).pairs().isNotEmpty()) startTransfer(context)
    }
    fun onBackground(context: Context) {}
}
