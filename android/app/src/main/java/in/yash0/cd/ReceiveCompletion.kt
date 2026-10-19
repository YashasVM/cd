package `in`.yash0.cd

/** Keeps publication and protocol completion ordered across their fallible I/O boundaries. */
object ReceiveCompletion {
    fun finish(
        trustedReceiptFallback: Boolean = false,
        publish: () -> String,
        completed: (String) -> Unit,
        sendReceipt: () -> Unit,
        awaitConfirmation: () -> Unit,
        cleanup: () -> Unit,
    ) {
        val uri = publish()
        // Paired sends can recover a lost data-channel receipt through the authenticated
        // control channel's "received" response for this durably published transfer.
        if (trustedReceiptFallback) completed(uri)
        sendReceipt()
        if (trustedReceiptFallback) runCatching { awaitConfirmation() }
        else {
            // Unpaired links have no second receipt channel. Keep their task retryable,
            // with its existing publication and checkpoint, until confirmation arrives.
            awaitConfirmation()
            completed(uri)
        }
        cleanup()
    }
}
