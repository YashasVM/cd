package `in`.yash0.cd

internal inline fun tolerateTransientNetwork(action: () -> Unit) {
    try { action() } catch (_: TransientNetworkException) { }
}
