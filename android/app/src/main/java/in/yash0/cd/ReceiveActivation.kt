package `in`.yash0.cd

/** Foreground activation never needs a previously enabled receiver (including a fresh install). */
object ReceiveActivation {
    fun shouldStart(paused: Boolean, hasTrustedDevices: Boolean, hasQueuedTransfers: Boolean): Boolean =
        !paused && (hasTrustedDevices || hasQueuedTransfers)
}
