package `in`.yash0.cd.sample

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import `in`.yash0.cd.sdk.*
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Host-owned UI, worker lifetime and private files. No CD app dependency. */
class SampleActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private var operation: TransferOperation? = null
    private var consent: CompletableFuture<TransferSink?>? = null
    private var dialog: AlertDialog? = null
    private lateinit var base: EditText
    private lateinit var link: EditText
    private lateinit var status: TextView
    @Volatile private var destroyed = false
    @Volatile private var busy = false
    @Volatile private var cancelled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        fun text(value: String) = TextView(this).apply { text = value }.also(layout::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { action() } }.also(layout::addView)
        text("Live file transfer sample")
        text("Keep both apps open. Links grant access to one receiver. The relay does not store files. Received files stay in this app's private storage.")
        base = EditText(this).apply { setText("https://cd.yash0.in"); hint = "Relay origin" }.also(layout::addView)
        link = EditText(this).apply { hint = "Paste a complete v2 invitation"; setSingleLine(false) }.also(layout::addView)
        button("Choose and send one file") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { type = "*/*"; addCategory(Intent.CATEGORY_OPENABLE) }, 1)
        }
        button("Receive invitation") {
            val invitation = link.text.toString()
            start { client ->
                val incoming = client.incoming(invitation, ::update)
                install(incoming)
                incoming.run { offer ->
                    val decision = CompletableFuture<TransferSink?>()
                    synchronized(this) {
                        if (destroyed || cancelled) decision.complete(null) else consent = decision
                    }
                    runOnUiThread {
                        if (destroyed || decision.isDone) return@runOnUiThread
                        dialog = AlertDialog.Builder(this).setTitle("Accept file?")
                            .setMessage("${offer.name}\n${offer.size} bytes\nSHA-256: ${offer.sha256}\nApp ID is unverified: ${offer.appId ?: "unspecified"}")
                            .setPositiveButton("Accept") { _, _ -> decision.complete(destination()) }
                            .setNegativeButton("Reject") { _, _ -> decision.complete(null) }
                            .setOnCancelListener { decision.complete(null) }.show()
                    }
                    try { decision.get(10, TimeUnit.MINUTES) } finally {
                        synchronized(this) { consent = null }
                        runOnUiThread { dialog?.dismiss(); dialog = null }
                    }
                }
            }
        }
        button("Cancel") { cancel() }
        status = text("Ready. To try locally, use http://10.0.2.2:8787 on an emulator. Only the debug sample permits local cleartext traffic.")
        setContentView(ScrollView(this).apply { addView(layout) })
    }
    private fun update(update: TransferUpdate) = show("${update.state}: ${update.bytes}/${update.total} bytes")
    private fun show(message: String) { runOnUiThread { if (!destroyed) status.text = message } }
    @Synchronized private fun install(value: TransferOperation) { if (destroyed || cancelled) { value.close(); error("Activity closed or cancelled") }; operation = value }
    @Synchronized private fun cancel() { cancelled = true; operation?.close(); consent?.complete(null); dialog?.dismiss(); dialog = null }
    private fun start(block: (CdTransferClient) -> VerifiedFile) {
        if (busy) { show("Cancel the active transfer and wait for it to stop before starting another."); return }
        busy = true
        cancelled = false
        val origin = base.text.toString()
        worker.execute {
            try {
                val result = block(CdTransferClient(packageName, origin))
                show("Verified ${result.size} bytes\nSHA-256: ${result.sha256}")
            } catch (e: Exception) { show(if (cancelled) "CANCELLED" else if (e is TransferException) e.state.name else "Failed. Check the invitation, relay and available storage.") }
            finally { synchronized(this) { operation = null; busy = false } }
        }
    }
    @Deprecated("Platform callback used to keep the sample free of UI dependencies")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 1 || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        start { client ->
            val source = File(cacheDir, "send-${UUID.randomUUID()}")
            try {
                contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input)
                    source.outputStream().use { output ->
                        val buffer = ByteArray(262144)
                        while (true) {
                            check(!cancelled && !destroyed && !Thread.currentThread().isInterrupted)
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                        }
                    }
                }
                val digest = MessageDigest.getInstance("SHA-256")
                source.inputStream().use { input -> val b = ByteArray(262144); while (true) { check(!cancelled && !destroyed && !Thread.currentThread().isInterrupted); val n = input.read(b); if (n < 0) break; digest.update(b, 0, n) } }
                val sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                val outgoing = client.outgoing(TransferSource(filename(uri), source.length(), sha256, source::inputStream), onUpdate = ::update)
                install(outgoing)
                outgoing.run { invitation -> runOnUiThread { if (!destroyed) link.setText(invitation) } }
            } finally { source.delete() }
        }
    }
    private fun filename(uri: Uri): String {
        val raw = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "file.bin"
        return raw.replace(Regex("[/\\\\\\p{Cntrl}]"), "_").take(60).takeUnless { it in listOf("", ".", "..") } ?: "file.bin"
    }
    private fun destination(): TransferSink = object : TransferSink {
        val stage = File(cacheDir, "receive-${UUID.randomUUID()}.part")
        override fun open(): OutputStream = stage.outputStream()
        override fun commit(file: VerifiedFile) {
            val target = File(filesDir, "received-${UUID.randomUUID()}")
            check(stage.renameTo(target)) { "Cannot publish received file" }
        }
        override fun abort() { stage.delete() }
    }
    override fun onDestroy() {
        synchronized(this) { destroyed = true; cancel() }
        worker.shutdownNow()
        super.onDestroy()
    }
}
