package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class SendNetworkGuardTest {
    @Test fun cellularOnlyStartAndResumePauseWithoutMobileOptIn() {
        for (attempt in listOf("start", "resume")) {
            val guard = SendNetworkGuard { NativeNetworkPolicy.allowed(false, false, false, true, false, false) }
            val error = assertThrows(SendProblem::class.java) { guard.check() }
            assertEquals(attempt, SendFailureKind.NETWORK_POLICY, SendFailures.classify(error))
            assertFalse(error.kind.terminal)
        }
    }
    @Test fun wifiAndExplicitMobileOptInCanSend() {
        SendNetworkGuard { NativeNetworkPolicy.allowed(false, true, false, false, false, true) }.check()
        SendNetworkGuard { NativeNetworkPolicy.allowed(true, false, false, true, false, false) }.check()
    }
    @Test fun changingPolicyStopsAnAlreadySelectedCellularTransport() {
        var mobile = true
        val guard = SendNetworkGuard { NativeNetworkPolicy.allowed(mobile, false, false, true, false, false) }
        guard.check()
        mobile = false
        assertThrows(SendProblem::class.java) { guard.check() }
    }
    @Test fun meteredWifiAndLostSelectedNetworkPause() {
        var unmetered = true
        val guard = SendNetworkGuard { NativeNetworkPolicy.allowed(false, true, false, false, false, unmetered) }
        guard.check()
        unmetered = false
        assertThrows(SendProblem::class.java) { guard.check() }
        assertThrows(SendProblem::class.java) { SendNetworkGuard { false }.check() }
    }
}
