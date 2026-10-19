package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ReceivePublicationTest {
    @Test fun cancellationDeletesOnlyAnUnpublishedPendingCopy() {
        var deletes = 0
        assertTrue(ReceivePublication.discardPending({ ReceivePublication.State.PENDING }, { ++deletes }))
        assertEquals(1, deletes)
    }

    @Test fun cancellationAfterPublicationPreservesTheSavedFileEvenWithoutAReceipt() {
        var deletes = 0
        assertTrue(ReceivePublication.discardPending({ ReceivePublication.State.PUBLISHED }, { ++deletes }))
        assertEquals(0, deletes)
    }

    @Test fun missingPublicationIsKnownSafeWithoutAnotherDelete() {
        var deletes = 0
        assertTrue(ReceivePublication.discardPending({ ReceivePublication.State.MISSING }, { ++deletes }))
        assertEquals(0, deletes)
    }

    @Test fun unknownPublicationStateKeepsCleanupRetryableWithoutDeletingAFile() {
        var deletes = 0
        assertFalse(ReceivePublication.discardPending({ ReceivePublication.State.UNKNOWN }, { ++deletes }))
        assertEquals(0, deletes)
    }

    @Test fun resolverFailureStopsCleanupWithoutDeletingTheSavedFile() {
        var deletes = 0
        assertThrows(IOException::class.java) {
            ReceivePublication.discardPending({ throw IOException("Provider unavailable") }, { ++deletes })
        }
        assertEquals(0, deletes)
    }

    @Test fun zeroRowConditionalDeleteNeedsARecheckBeforeCleanupCanFinish() {
        var deletes = 0
        assertFalse(ReceivePublication.discardPending({ ReceivePublication.State.PENDING }, { deletes++; 0 }))
        // Publication won the query/delete race. A later pass may now safely finish cleanup.
        assertTrue(ReceivePublication.discardPending({ ReceivePublication.State.PUBLISHED }, { deletes++; 1 }))
        assertEquals(1, deletes)
    }
}
