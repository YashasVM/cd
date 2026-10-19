package `in`.yash0.cd

/** Checked before admission, before data writes, and while awaiting a peer. */
class SendNetworkGuard(private val allowed: () -> Boolean) {
    fun check() {
        if (!allowed()) throw SendProblem(SendFailureKind.NETWORK_POLICY)
    }
}
