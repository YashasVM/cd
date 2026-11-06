package `in`.yash0.cd.transfer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import java.io.OutputStream

/**
 * Streams incoming bytes straight to disk (MediaStore on Q+),
 * fixing the web fallback that buffers whole files in RAM as Blob chunks.
 */
class FileSaver(private val context: Context) {
    class Sink(
        private val context: Context,
        val uri: Uri,
        val stream: OutputStream,
    ) {
        private var finished = false

        fun complete() {
            if (finished) return
            stream.close()
            val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            check(context.contentResolver.update(uri, values, null, null) == 1) { "could not publish download" }
            finished = true
        }

        fun abort() {
            if (finished) return
            runCatching { stream.close() }
            context.contentResolver.delete(uri, null, null)
            finished = true
        }
    }

    fun open(name: String, mime: String): Sink {
        val safeName = safeFilename(name) ?: throw IllegalArgumentException("unsafe filename")
        val safeMime = mime.ifBlank { "application/octet-stream" }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName)
            put(MediaStore.Downloads.MIME_TYPE, safeMime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/cd")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("could not create download")
        val stream = context.contentResolver.openOutputStream(uri)
            ?: run {
                context.contentResolver.delete(uri, null, null)
                throw IllegalStateException("could not open download")
            }
        return Sink(context, uri, stream)
    }

    companion object {
        fun safeFilename(value: String): String? {
            if (value.isBlank() || value == "." || value == "..") return null
            if (value.toByteArray(Charsets.UTF_8).size > 255) return null
            if (value.any { it == '/' || it == '\\' || it.code < 32 || it.code == 127 }) return null
            return value
        }
    }
}
