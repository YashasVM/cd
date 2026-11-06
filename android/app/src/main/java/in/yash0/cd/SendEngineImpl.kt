package `in`.yash0.cd

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.security.DigestOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Foreground process scope only. No service, alarm, worker or automatic restart. */
class SendEngineImpl(private val context: Context, private val publicBase: String = "https://cd.yash0.in", private val directEnabled: Boolean = true) : SendEngine {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = SenderStore(context)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private class Running(val scope: CoroutineScope) {
        @Volatile var wire: Wire? = null
        var job: Job? = null
        fun active() = scope.coroutineContext.ensureActive()
        fun stop() { scope.cancel(); wire?.close() }
    }
    private val running = ConcurrentHashMap<String, Running>()
    init {
        // Parsing validates the origin before any credentials are sent.
        Invitation.parse("${publicBase.trimEnd('/')}/s/${Crypto.encode(ByteArray(16))}#v2.${Crypto.encode(ByteArray(32))}")
        store.all().forEach { state ->
            val phase = runCatching { TransferPhase.valueOf(state.optString("phase")) }.getOrDefault(TransferPhase.PAUSED)
            publish(state, if (phase in setOf(TransferPhase.COMPLETE, TransferPhase.CANCELLED, TransferPhase.FAILED)) phase else TransferPhase.PAUSED)
        }
    }
    override fun start(context: Context, uris: List<Uri>): String {
        require(uris.isNotEmpty()) { "Choose at least one file" }
        val id = Crypto.encode(Crypto.random(16))
        val state = JSONObject().put("id", id).put("key", Crypto.encode(Crypto.random(32))).put("senderToken", Crypto.encode(Crypto.random(32)))
            .put("publicBase", publicBase.trimEnd('/')).put("uris", JSONArray(uris.map(Uri::toString)))
            .put("name", if (uris.size == 1) name(uris.first()) else "files.zip").put("size", if (uris.size == 1) size(uris.first()) else -1L).put("done", 0L)
            .put("phase", TransferPhase.PREPARING.name).put("expiresAt", 0L)
        uris.forEach { uri -> runCatching { this.context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        store.save(state)
        publish(state, TransferPhase.PREPARING)
        launch(id) { run ->
            prepare(state, run)
            transfer(state, run)
        }
        return id
    }
    override fun pause(context: Context, id: String) = stop(id, TransferPhase.PAUSED)
    override fun cancel(context: Context, id: String) = stop(id, TransferPhase.CANCELLED)
    private fun stop(id: String, phase: TransferPhase) {
        synchronized(this) {
            running[id]?.stop()
            val state = store.load(id)
            state.put("phase", phase.name)
            store.save(state)
            if (phase == TransferPhase.CANCELLED) { store.source(id).delete(); File(store.directory, "$id.pending").delete() }
            publish(state, phase)
        }
    }
    override fun resume(context: Context, id: String) {
        synchronized(this) {
            if (running[id]?.scope?.coroutineContext?.get(Job)?.isActive == true) return
            val state = store.load(id)
            require(state.optString("phase") !in listOf(TransferPhase.COMPLETE.name, TransferPhase.CANCELLED.name)) { "Transfer already finished" }
            val phase = if (state.has("digest")) TransferPhase.CONNECTING else TransferPhase.PREPARING
            state.put("phase", phase.name)
            store.save(state)
            publish(state, phase)
            launch(id) { run ->
                if (!state.has("digest")) prepare(state, run)
                transfer(state, run)
            }
        }
    }
    private fun launch(id: String, block: (Running) -> Unit) {
        synchronized(this) {
            if (running[id]?.scope?.coroutineContext?.get(Job)?.isActive == true) return
            val previous = running[id]
            val run = Running(CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job])))
            running[id] = run
            run.job = run.scope.launch {
                try { previous?.job?.join(); run.active(); block(run) }
                catch (e: Exception) {
                    synchronized(this@SendEngineImpl) {
                        if (running[id] === run && run.scope.coroutineContext[Job]?.isActive == true) {
                            val state = store.load(id)
                            state.put("phase", TransferPhase.PAUSED.name)
                            store.save(state)
                            publish(state, TransferPhase.PAUSED, message = e.message ?: "Transfer interrupted. Resume to continue.")
                        }
                    }
                } finally { run.wire?.close(); running.remove(id, run); run.scope.cancel() }
            }
        }
    }
    private fun name(uri: Uri): String {
        var value: String? = null
        runCatching { context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) value = cursor.getString(0)
        } }
        return (value ?: uri.lastPathSegment ?: "file").replace(Regex("[/\\\\\\p{Cntrl}]"), "_").take(200).takeUnless { it in listOf("", ".", "..") } ?: "file"
    }
    private fun size(uri: Uri): Long = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
        } ?: -1L
    }.getOrDefault(-1L)
    private fun input(uri: Uri): InputStream = BufferedInputStream(context.contentResolver.openInputStream(uri) ?: throw IOException("Cannot open selected file"), 1024 * 1024)
    private fun prepare(state: JSONObject, run: Running) {
        val id = state.getString("id")
        val pending = File(store.directory, "$id.pending")
        val digest = MessageDigest.getInstance("SHA-256")
        val uris = state.getJSONArray("uris").let { array -> (0 until array.length()).map { Uri.parse(array.getString(it)) } }
        val buffer = ByteArray(1024 * 1024)
        fun copy(uri: Uri, output: java.io.OutputStream) {
            input(uri).use { source ->
                while (true) {
                    run.active()
                    val n = source.read(buffer)
                    if (n < 0) break
                    require(store.directory.usableSpace > n + 8L * 1024 * 1024) { "Not enough phone storage to retain this send" }
                    output.write(buffer, 0, n)
                }
            }
        }
        try {
            BufferedOutputStream(DigestOutputStream(pending.outputStream(), digest), 1024 * 1024).use { output ->
                if (uris.size == 1) copy(uris.single(), output)
                else ZipOutputStream(output).use { zip ->
                    // Level zero keeps bundles fast, and a saved archive makes resume byte-stable.
                    zip.setLevel(0)
                    val used = mutableSetOf<String>()
                    uris.forEachIndexed { index, uri ->
                        var entryName = name(uri)
                        if (!used.add(entryName)) { entryName = "${index + 1}-$entryName"; require(used.add(entryName)) }
                        zip.putNextEntry(ZipEntry(entryName))
                        copy(uri, zip)
                        zip.closeEntry()
                    }
                }
            }
            run.active()
            require(pending.length() <= 9007199254740991L) { "File is too large" }
            java.io.RandomAccessFile(pending, "rw").use { it.fd.sync() }
            synchronized(this) {
                run.active()
                check(pending.renameTo(store.source(id))) { "Could not retain send source" }
                state.put("size", store.source(id).length()).put("digest", Crypto.hex(digest.digest())).put("phase", TransferPhase.WAITING.name)
                store.save(state)
            }
        } finally { pending.delete() }
    }
    private fun publish(state: JSONObject, phase: TransferPhase, rate: Long = 0, route: Route = Route.NONE, message: String? = null) {
        val link = if (state.has("digest")) "${state.getString("publicBase")}/s/${state.getString("id")}#v2.${state.getString("key")}" else null
        TransferBus.publish(TransferView(state.getString("id"), Direction.SEND, state.getString("name"), state.getLong("size"), state.optLong("done"), rate, phase, route, link = link, message = message))
    }
    private fun transfer(state: JSONObject, run: Running) {
        run.active()
        val id = state.getString("id")
        val invitation = Invitation.parse("${state.getString("publicBase")}/s/$id#v2.${state.getString("key")}")
        val senderToken = Crypto.decode(state.getString("senderToken"), 32)
        val nonce = Crypto.random(32)
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v2").put("role", "sender")
            .put("senderToken", Crypto.encode(senderToken)).put("senderTokenHash", Crypto.encode(Crypto.sha(senderToken)))
            .put("receiverTokenHash", Crypto.encode(Crypto.sha(invitation.token()))).put("sessionNonce", Crypto.encode(nonce)).put("nonceProof", Crypto.encode(invitation.proof("sender", nonce)))
        if (state.getLong("expiresAt") != 0L) {
            require(state.getLong("expiresAt") > System.currentTimeMillis()) { "This link expired. Start a new send." }
            join.put("expiresAt", state.getLong("expiresAt"))
        }
        publish(state, TransferPhase.CONNECTING)
        Wire(client, invitation.relay) { ws -> ws.send(join.toString()) }.use { wire ->
            run.wire = wire
            run.active()
            var expiry = 0L
            lateinit var paired: JSONObject
            while (true) {
                run.active()
                val event = wire.json(15 * 60)
                if (event.getString("type") == "accepted") {
                    expiry = event.getLong("expiresAt")
                    require(expiry > System.currentTimeMillis() && expiry <= System.currentTimeMillis() + 86430000L)
                    require(state.getLong("expiresAt") == 0L || state.getLong("expiresAt") == expiry) { "Transfer expiry changed" }
                    synchronized(this) { run.active(); state.put("expiresAt", expiry).put("phase", TransferPhase.WAITING.name); store.save(state) }
                    publish(state, TransferPhase.WAITING)
                }
                if (event.optString("receiverNonce").isNotEmpty()) { paired = event; break }
            }
            require(paired.getLong("expiresAt") == expiry && Crypto.decode(paired.getString("sessionNonce"), 32).contentEquals(nonce)) { "Relay changed sender session" }
            val receiver = Crypto.decode(paired.getString("receiverNonce"), 32)
            require(MessageDigest.isEqual(Crypto.decode(paired.getString("receiverNonceProof"), 32), invitation.proof("receiver", receiver))) { "Receiver authentication failed" }
            val sealer = SendRecords(invitation, nonce, receiver)
            val opener = Records(invitation, nonce, receiver, false)
            fun relay(record: ByteArray) {
                run.active()
                // The ACK window is 4 MiB, below OkHttp's hard 16 MiB limit. Also bound non-data records.
                while (wire.socket.queueSize() + record.size > 8L * 1024 * 1024) { run.active(); Thread.sleep(2) }
                if (!wire.socket.send(record.toByteString())) throw IOException("Send connection closed")
            }
            val size = state.getLong("size")
            val digest = state.getString("digest")
            val direct = if (directEnabled && size >= 1024 * 1024) SenderDirect(context) { wire.abort(it) } else null
            try {
                val offer = JSONObject().put("name", state.getString("name")).put("size", size.toString()).put("chunkSize", SendProtocol.CHUNK)
                    .put("wholeSha256", digest).put("expiresAt", expiry).put("windowBytes", SendProtocol.WINDOW)
                direct?.offer()?.let { offer.put("direct", JSONObject().put("sdp", it)) }
                relay(sealer.seal(1, offer.toString().toByteArray()))
                fun next(): Pair<Int, ByteArray> {
                    while (true) {
                        run.active()
                        when (val frame = wire.next()) {
                            is Frame.Binary -> {
                                val record = opener.open(frame.bytes)
                                if (record.first == 9) { direct?.signal(JSONObject(String(record.second))); continue }
                                return record
                            }
                            is Frame.Text -> ReceiveGate.event(JSONObject(frame.text))
                            is Frame.Failed -> throw frame.error
                        }
                    }
                }
                val accepted = next()
                require(accepted.first == 4) { "Invalid receiver acceptance" }
                val accept = JSONObject(String(accepted.second))
                val offset = SendProtocol.offset(accept.getString("offset"), size)
                val ackEvery = accept.optLong("ackEveryBytes", SendProtocol.CHUNK.toLong())
                require(ackEvery in SendProtocol.CHUNK.toLong()..SendProtocol.WINDOW && ackEvery % SendProtocol.CHUNK == 0L) { "Invalid ACK interval" }
                store.source(id).inputStream().buffered(1024 * 1024).use { source ->
                    val whole = MessageDigest.getInstance("SHA-256")
                    val buffer = ByteArray(SendProtocol.CHUNK)
                    var prefix = offset
                    while (prefix > 0) {
                        run.active()
                        val n = source.read(buffer, 0, minOf(buffer.size.toLong(), prefix).toInt())
                        require(n > 0) { "Retained send source changed" }
                        whole.update(buffer, 0, n); prefix -= n
                    }
                    require(Crypto.hex((whole.clone() as MessageDigest).digest()) == accept.getString("prefixSha256")) { "Receiver checkpoint does not match this source" }
                    var sent = offset
                    var ack = offset
                    var usingDirect = false
                    var draining = false
                    val started = System.nanoTime()
                    var lastPublish = 0L
                    state.put("done", offset)
                    publish(state, TransferPhase.TRANSFERRING, route = Route.RELAY, message = if (offset > 0) "Resumed at $offset bytes" else null)
                    android.util.Log.i("CD-Send", "start id=$id offset=$offset size=$size")
                    while (ack < size) {
                        run.active()
                        if (!usingDirect) {
                            if (direct?.ready() != true) draining = false
                            else if ((sent - offset) % ackEvery == 0L || sent == size) draining = true
                            if (draining && sent == ack) { direct!!.markUsed(); usingDirect = true; draining = false }
                        }
                        while (sent < size && sent - ack < SendProtocol.WINDOW && !draining) {
                            run.active()
                            val n = minOf(buffer.size.toLong(), size - sent).toInt()
                            var filled = 0
                            while (filled < n) { val read = source.read(buffer, filled, n - filled); require(read > 0) { "Send source truncated" }; filled += read }
                            whole.update(buffer, 0, n)
                            val record = sealer.seal(2, buffer, n)
                            if (usingDirect) direct!!.send(record) { run.active() } else relay(record)
                            sent += n
                            if (!usingDirect && direct?.ready() == true && ((sent - offset) % ackEvery == 0L || sent == size)) draining = true
                        }
                        val record = next()
                        require(record.first == 5) { "Expected cumulative acknowledgement" }
                        ack = SendProtocol.ack(record.second, ack, sent, size)
                        state.put("done", ack)
                        val now = System.nanoTime()
                        if (now - lastPublish > 150000000L || ack == size) {
                            val rate = ((ack - offset) * 1e9 / (now - started).coerceAtLeast(1)).toLong()
                            publish(state, TransferPhase.TRANSFERRING, rate, if (usingDirect) Route.DIRECT else Route.RELAY)
                            lastPublish = now
                        }
                    }
                    require(source.read() == -1 && Crypto.hex(whole.digest()) == digest) { "Send source changed" }
                    publish(state, TransferPhase.VERIFYING, route = if (usingDirect) Route.DIRECT else Route.RELAY)
                    val end = SendProtocol.end(size, digest)
                    relay(sealer.seal(3, end))
                    val complete = next()
                    require(complete.first == 6 && complete.second.contentEquals(end)) { "Receiver did not verify complete file" }
                    while (true) {
                        val event = wire.json(10)
                        if (event.getString("type") == "completed") break
                        require(event.getString("type") == "complete" && event.getString("sessionNonce") == Crypto.encode(nonce) && event.getString("receiverNonce") == Crypto.encode(receiver))
                    }
                    synchronized(this) {
                        run.active()
                        state.put("phase", TransferPhase.COMPLETE.name)
                        store.save(state)
                        store.source(id).delete()
                        val rate = ((size - offset) * 1e9 / (System.nanoTime() - started).coerceAtLeast(1)).toLong()
                        publish(state, TransferPhase.COMPLETE, rate, if (usingDirect) Route.DIRECT else Route.RELAY)
                        android.util.Log.i("CD-Send", "complete id=$id resumed=$offset bytesPerSecond=$rate route=${if (usingDirect) "direct" else "relay"}")
                    }
                }
            } finally { direct?.close() }
        }
    }
}
