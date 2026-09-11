package `in`.yash0.cd.data

/** Plain models; JSON is built manually so no serialization plugin is needed. */
data class FileMeta(
    val index: Int,
    val name: String,
    val size: Long,
    val mimeType: String = "application/octet-stream",
)

data class Manifest(
    val totalFiles: Int,
    val totalSize: Long,
    val files: List<FileMeta>,
)

/** Wire message types — must match web src/main.js exactly. */
object Wire {
    const val MANIFEST = "manifest"
    const val FILE_START = "file-start"
    const val FILE_COMPLETE = "file-complete"
    const val TRANSFER_COMPLETE = "transfer-complete"
    const val TRANSFER_ACK = "transfer-ack"
    const val PROGRESS = "progress"
    const val CANCEL = "cancel"
}

enum class TransferState(val label: String) {
    IDLE("idle"),
    WAITING("waiting"),
    CONNECTING("connecting"),
    TRANSFERRING("transferring"),
    SAVING("saving"),
    COMPLETE("complete"),
    FAILED("failed"),
}

data class TransferProgress(
    val bytes: Long = 0L,
    val total: Long = 0L,
    val startedAtMs: Long = 0L,
) {
    val fraction: Float get() = if (total <= 0) 0f else (bytes.toFloat() / total).coerceIn(0f, 1f)
    val percent: Int get() = (fraction * 100).toInt()
    val speedBps: Long get() {
        if (startedAtMs <= 0L || bytes <= 0L) return 0L
        val s = ((System.currentTimeMillis() - startedAtMs) / 1000.0).coerceAtLeast(0.001)
        return (bytes / s).toLong()
    }
}
