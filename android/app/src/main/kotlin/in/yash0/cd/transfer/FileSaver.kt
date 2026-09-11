package `in`.yash0.cd.transfer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.OutputStream

/**
 * Streams incoming bytes straight to disk (MediaStore on Q+),
 * fixing the web fallback that buffers whole files in RAM as Blob chunks.
 */
class FileSaver(private val context: Context) {
    data class Sink(val uri: Uri, val stream: OutputStream)

    fun open(name: String, mime: String): Sink {
        val safeMime = mime.ifBlank { "application/octet-stream" }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, safeMime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/cd")
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
            Sink(uri, context.contentResolver.openOutputStream(uri)!!)
        } else {
            @Suppress("DEPRECATION")
            val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS + "/cd")
            dir.mkdirs()
            val file = java.io.File(dir, name)
            Sink(Uri.fromFile(file), file.outputStream())
        }
    }
}
