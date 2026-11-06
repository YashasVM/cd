package `in`.yash0.cd.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps transfers alive when the screen is off or the user switches apps —
 * the #1 thing the web app cannot do (it dies with the tab).
 */
class TransferService : Service() {
    private var wake: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cd:transfer").apply {
            acquire(30 * 60 * 1000L)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val label = intent?.getStringExtra(EXTRA_LABEL) ?: "Transfer running"
        startForeground(NOTIF_ID, buildNotif(label))
        return START_STICKY
    }

    override fun onDestroy() {
        runCatching { wake?.release() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotif(label: String): Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("cd")
            .setContentText(label)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()

    companion object {
        const val CHANNEL = "cd_transfer"
        const val NOTIF_ID = 41
        const val EXTRA_LABEL = "label"

        fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val mgr = ctx.getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(CHANNEL) == null) {
                mgr.createNotificationChannel(
                    NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW),
                )
            }
        }

        fun start(ctx: Context, label: String) {
            ensureChannel(ctx)
            val i = Intent(ctx, TransferService::class.java).putExtra(EXTRA_LABEL, label)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TransferService::class.java))
        }
    }
}
