package `in`.yash0.cd

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ReceiveCompletionTest {
    private class SavedTransfer {
        var state = "verifying"
        var publishedUri: String? = null
        var insertions = 0
        var cleanupCalls = 0
        var checkpoint = true
        var staging = true
        val events = mutableListOf<String>()

        fun finish(failure: String? = null, trustedReceiptFallback: Boolean = false) {
            val invitation = Invitation(Crypto.encode(ByteArray(16)), ByteArray(32), "wss://example.com/ws/v2/test")
            val sender = ByteArray(32) { 1 }
            val receiver = ByteArray(32) { 2 }
            val open = Records(invitation, sender, receiver, false)
            val writer = RecordWriter(Records(invitation, sender, receiver, false)) { record ->
                if (failure == "encrypted-receipt") throw IOException("Socket closed before COMPLETE")
                assertEquals(6, open.open(record).first)
                events.add("encrypted-receipt")
            }
            ReceiveCompletion.finish(
                trustedReceiptFallback = trustedReceiptFallback,
                publish = {
                    if (publishedUri == null) {
                        insertions++
                        publishedUri = "content://media/external/downloads/42"
                    }
                    events.add("published")
                    publishedUri!!
                },
                completed = { uri ->
                    assertEquals(publishedUri, uri)
                    state = "complete"
                    events.add("complete")
                },
                sendReceipt = {
                    writer.send(6, counts(0) + Crypto.sha(byteArrayOf()))
                    if (failure == "relay-control") throw IOException("Socket closed before terminal control")
                    events.add("relay-control")
                },
                awaitConfirmation = {
                    if (failure == "confirmation") throw WireTimeout()
                    events.add("confirmed")
                },
                cleanup = {
                    cleanupCalls++
                    checkpoint = false
                    staging = false
                    events.add("cleanup")
                },
            )
        }
    }

    @Test fun encryptedCompletionSendFailureKeepsTransferRetryable() {
        val transfer = SavedTransfer()
        assertThrows(IOException::class.java) { transfer.finish("encrypted-receipt") }
        assertEquals("verifying", transfer.state)
        assertNotNull(transfer.publishedUri)
        assertTrue(transfer.checkpoint)
        assertTrue(transfer.staging)
        assertEquals(0, transfer.cleanupCalls)
    }

    @Test fun terminalControlSendFailureKeepsTransferRetryable() {
        val transfer = SavedTransfer()
        assertThrows(IOException::class.java) { transfer.finish("relay-control") }
        assertEquals("verifying", transfer.state)
        assertTrue(transfer.checkpoint)
        assertTrue(transfer.staging)
        assertEquals(0, transfer.cleanupCalls)
    }

    @Test fun lostTerminalConfirmationKeepsRecoveryInsteadOfSilentlyCompleting() {
        val transfer = SavedTransfer()
        assertThrows(WireTimeout::class.java) { transfer.finish("confirmation") }
        assertEquals("verifying", transfer.state)
        assertNotNull(transfer.publishedUri)
        assertTrue(transfer.checkpoint)
        assertTrue(transfer.staging)
        assertEquals(0, transfer.cleanupCalls)
    }

    @Test fun confirmedCompletionCleansRetainedFilesExactlyOnce() {
        val transfer = SavedTransfer()
        transfer.finish()
        assertEquals(listOf("published", "encrypted-receipt", "relay-control", "confirmed", "complete", "cleanup"), transfer.events)
        assertEquals("complete", transfer.state)
        assertEquals(1, transfer.cleanupCalls)
        assertFalse(transfer.checkpoint)
        assertFalse(transfer.staging)
    }

    @Test fun retryReusesTheDurablePublicationAndFinishesWithoutAnotherCopy() {
        val transfer = SavedTransfer()
        assertThrows(IOException::class.java) { transfer.finish("encrypted-receipt") }
        val savedUri = transfer.publishedUri
        assertEquals("verifying", transfer.state)
        transfer.finish()
        assertEquals(savedUri, transfer.publishedUri)
        assertEquals(1, transfer.insertions)
        assertEquals(1, transfer.cleanupCalls)
        assertEquals("complete", transfer.state)
    }

    @Test fun pairedTransferRetainsTheAuthenticatedControlReceiptFallback() {
        val transfer = SavedTransfer()
        assertThrows(IOException::class.java) { transfer.finish("encrypted-receipt", trustedReceiptFallback = true) }
        // ReceiverService can report the already-saved transfer over its trusted control channel.
        assertEquals("complete", transfer.state)
        assertNotNull(transfer.publishedUri)
        assertEquals(0, transfer.cleanupCalls)
    }

    @Test fun pairedTransferCanStillFinishLocallyWhenTheTerminalAcknowledgmentIsLost() {
        val transfer = SavedTransfer()
        transfer.finish("confirmation", trustedReceiptFallback = true)
        assertEquals("complete", transfer.state)
        assertEquals(1, transfer.cleanupCalls)
    }
}
