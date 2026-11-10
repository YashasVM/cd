package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test

class ReceiveGateTest {
    @Test fun transientNetworkChangeDoesNotEscapeServiceLoop() {
        var continued = false
        tolerateTransientNetwork { throw TransientNetworkException() }
        tolerateTransientNetwork { continued = true }
        assertTrue(continued)
    }

    @Test fun unrelatedFailuresStillEscape() {
        val failure = IllegalStateException("unexpected")
        try {
            tolerateTransientNetwork { throw failure }
            fail("unrelated failure was swallowed")
        } catch (actual: IllegalStateException) {
            assertSame(failure, actual)
        }
    }
}
