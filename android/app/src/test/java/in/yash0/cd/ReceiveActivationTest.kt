package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class ReceiveActivationTest {
    @Test fun freshInstallStartsAfterFirstTrustWithoutAnEnabledFlag() {
        assertFalse(ReceiveActivation.shouldStart(false, false, false))
        assertTrue(ReceiveActivation.shouldStart(false, true, false))
    }
    @Test fun reopeningAndUnpausingReconnectTrustedDevices() {
        assertTrue(ReceiveActivation.shouldStart(false, true, false))
        assertTrue(ReceiveActivation.shouldStart(false, false, true))
    }
    @Test fun pauseAndNotificationStopWinOverTrustAndPendingTransfers() {
        for (trusted in listOf(false, true)) for (queued in listOf(false, true)) {
            assertFalse(ReceiveActivation.shouldStart(true, trusted, queued))
        }
    }
}
