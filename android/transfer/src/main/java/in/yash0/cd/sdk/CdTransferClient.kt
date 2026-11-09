package `in`.yash0.cd.sdk

import `in`.yash0.cd.*
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.TimeUnit

/** The host supplies an immutable source and a lowercase SHA-256 computed before sharing. */
class TransferSource(val name: String, val size: Long, val sha256: String, val open: () -> InputStream) {
    init {
        OrdinaryOffer.parse(JSONObject().put("name", name).put("size", size.toString()).put("chunkSize", SendProtocol.CHUNK))
        require(sha256.matches(Regex("[a-f0-9]{64}"))) { "Invalid SHA-256" }
    }
}

data class TransferOffer(val name: String, val size: Long, val sha256: String, val expiresAt: Long, val appId: String?)
data class VerifiedFile(val size: Long, val sha256: String)

/** Stage privately. commit publishes only verified content; abort removes any partial output. */
interface TransferSink {
    fun open(): OutputStream
    fun commit(file: VerifiedFile)
    fun abort()
}

enum class TransferState { CONNECTING, WAITING, AWAITING_CONSENT, TRANSFERRING, VERIFYING, COMPLETE, REJECTED, EXPIRED, CANCELLED, FAILED, RECOVERABLE_FAILURE }
data class TransferUpdate(val state: TransferState, val bytes: Long = 0, val total: Long = 0)
class TransferException(val state: TransferState, cause: Throwable? = null) : IOException("Transfer ${state.name.lowercase()}", cause)

/** No UI, storage, service or application context. Call run on a host-owned worker thread. */
class CdTransferClient(
    val appId: String,
    private val publicBase: String = "https://cd.yash0.in",
    private val http: OkHttpClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build(),
) {
    init {
        require(appId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))) { "Invalid public appId" }
        invitation()
    }
    private fun invitation(): String = "${publicBase.trimEnd('/')}/s/${Crypto.encode(Crypto.random(16))}#v2.${Crypto.encode(Crypto.random(32))}".also { Invitation.parse(it) }

    /** The link is delivered to onReady only after relay admission. Lifetime is at most 24 hours. */
    fun outgoing(source: TransferSource, lifetimeMillis: Long = 15 * 60 * 1000L, onUpdate: (TransferUpdate) -> Unit = {}): OutgoingTransfer {
        require(lifetimeMillis in 1000..86400000L)
        return OutgoingTransfer(Invitation.parse(invitation()), source, lifetimeMillis, appId, http, onUpdate)
    }
    fun incoming(link: String, onUpdate: (TransferUpdate) -> Unit = {}): IncomingTransfer {
        val invitation = Invitation.parse(link)
        require(invitation.version == 2) { "This preview API supports v2 fragment links only" }
        return IncomingTransfer(invitation, http, onUpdate)
    }
}

/** One run only. close cancels, closes the socket and active stream, and wakes network waits.
 * Callbacks run on the run thread. They must return promptly or wait interruptibly under host control.
 * Failure is thrown and reported as a terminal update. A recoverable failure needs a NEW invitation.
 */
abstract class TransferOperation internal constructor(
    internal val invitation: Invitation, private val http: OkHttpClient,
    private val onUpdate: (TransferUpdate) -> Unit,
) : Closeable {
    private var started = false
    @Volatile private var stopped: TransferState? = null
    private var wire: Wire? = null
    private var stream: Closeable? = null
    private var finished = false
    @Volatile private var published: VerifiedFile? = null
    private var timer: Timer? = null
    @Volatile var state = TransferState.CONNECTING
        private set

    internal fun update(value: TransferState, bytes: Long = 0, total: Long = 0) {
        state = value
        onUpdate(TransferUpdate(value, bytes, total))
    }
    internal fun active() { stopped?.let { throw TransferException(it) } }
    @Synchronized internal fun attach(value: Closeable?) { active(); stream = value }
    @Synchronized private fun stop(reason: TransferState) {
        if (finished || stopped != null) return
        stopped = reason
        wire?.close()
        runCatching { stream?.close() }
    }
    @Synchronized internal fun markPublished(result: VerifiedFile) { published = result; finished = true }
    override fun close() = stop(TransferState.CANCELLED)
    internal fun expire(at: Long) {
        require(at > System.currentTimeMillis() && at <= System.currentTimeMillis() + 86430000L) { "Invalid expiry" }
        timer = Timer("cd-transfer-expiry", true).also {
            it.schedule(object : TimerTask() { override fun run() = stop(TransferState.EXPIRED) }, (at - System.currentTimeMillis()).coerceAtLeast(0))
        }
    }
    internal fun execute(join: JSONObject, body: (Wire) -> VerifiedFile): VerifiedFile {
        synchronized(this) { check(!started) { "Transfer already run" }; started = true }
        try {
            active(); update(TransferState.CONNECTING); active()
            Wire(http, invitation.relay) { it.send(join.toString()) }.use { socket ->
                synchronized(this) { wire = socket; active() }
                val result = body(socket)
                synchronized(this) { if (published == null) active(); finished = true }
                update(TransferState.COMPLETE, result.size, result.size)
                return result
            }
        } catch (error: Exception) {
            published?.let { result ->
                update(TransferState.COMPLETE, result.size, result.size)
                return result
            }
            val failure = stopped ?: when (error) {
                is TransferException -> error.state
                is ReceiverRejectedException -> TransferState.REJECTED
                is SourceChangedException -> TransferState.FAILED
                is WireFailure -> if (error.expired) TransferState.EXPIRED else if (error.status == 4401 || error.exhausted) TransferState.FAILED else TransferState.RECOVERABLE_FAILURE
                is IOException -> TransferState.RECOVERABLE_FAILURE
                else -> TransferState.FAILED
            }
            synchronized(this) { finished = true }
            update(failure)
            throw TransferException(failure, error)
        } finally { timer?.cancel(); synchronized(this) { wire = null; stream = null } }
    }
    internal fun next(wire: Wire, opener: Records, seconds: Long = 90): Pair<Int, ByteArray> {
        while (true) {
            active()
            when (val frame = wire.next(seconds)) {
                is Frame.Binary -> return opener.open(frame.bytes).also { active() }
                is Frame.Text -> ReceiveGate.event(JSONObject(frame.text))
                is Frame.Failed -> throw frame.error
            }
        }
    }
}

class OutgoingTransfer internal constructor(
    invitation: Invitation, private val source: TransferSource, private val lifetime: Long,
    private val appId: String, http: OkHttpClient, onUpdate: (TransferUpdate) -> Unit,
) : TransferOperation(invitation, http, onUpdate) {
    /** Keep run alive until verified completion. Never log or send the link to the relay. */
    fun run(onReady: (String) -> Unit): VerifiedFile {
        val nonce = Crypto.random(32)
        val token = Crypto.random(32)
        val expiry = System.currentTimeMillis() + lifetime
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v2").put("role", "sender")
            .put("senderToken", Crypto.encode(token)).put("senderTokenHash", Crypto.encode(Crypto.sha(token)))
            .put("receiverTokenHash", Crypto.encode(Crypto.sha(invitation.token()))).put("sessionNonce", Crypto.encode(nonce))
            .put("nonceProof", Crypto.encode(invitation.proof("sender", nonce))).put("expiresAt", expiry).put("appId", appId)
        return execute(join) { wire ->
            val admitted = wire.json(10)
            require(admitted.getString("type") == "accepted" && admitted.getLong("expiresAt") == expiry)
            require(Crypto.decode(admitted.getString("sessionNonce"), 32).contentEquals(nonce))
            require(MessageDigest.isEqual(Crypto.decode(admitted.getString("senderNonceProof"), 32), invitation.proof("sender", nonce)))
            expire(expiry); update(TransferState.WAITING)
            val relay = java.net.URI(invitation.relay)
            val link = "${if (relay.scheme == "wss") "https" else "http"}://${relay.rawAuthority}/s/${invitation.id}#v2.${Crypto.encode(invitation.key)}"
            onReady(link); active()
            var paired = wire.json(900)
            while (paired.getString("type") != "peer-joined") paired = wire.json(900)
            require(paired.getLong("expiresAt") == expiry && paired.getString("sessionNonce") == Crypto.encode(nonce))
            val receiver = Crypto.decode(paired.getString("receiverNonce"), 32)
            require(MessageDigest.isEqual(Crypto.decode(paired.getString("receiverNonceProof"), 32), invitation.proof("receiver", receiver)))
            val sealer = SendRecords(invitation, nonce, receiver)
            val opener = Records(invitation, nonce, receiver, false)
            val offer = JSONObject().put("name", source.name).put("size", source.size.toString()).put("wholeSha256", source.sha256)
                .put("chunkSize", SendProtocol.CHUNK).put("windowBytes", SendProtocol.WINDOW).put("expiresAt", expiry).put("appId", appId)
            wire.send(sealer.seal(1, offer.toString().toByteArray()))
            update(TransferState.AWAITING_CONSENT)
            val accepted = next(wire, opener, 600)
            require(accepted.first == 4) { "Expected acceptance" }
            val accept = JSONObject(String(accepted.second))
            if (accept.optBoolean("rejected")) throw ReceiverRejectedException()
            // A fresh SDK send never accepts a retained checkpoint from a different operation.
            require(accept.getString("offset") == "0") { "Fresh transfer requires offset zero" }
            source.open().use { input ->
                attach(input)
                LiveContent.send(input, source.size, source.sha256, accept, sealer::seal, wire::send,
                    { next(wire, opener) }, ::active,
                    { done, _ -> update(TransferState.TRANSFERRING, done, source.size) },
                    { update(TransferState.VERIFYING, source.size, source.size) })
                attach(null)
            }
            while (wire.json(10).getString("type") != "completed") { active() }
            VerifiedFile(source.size, source.sha256)
        }
    }
}

class IncomingTransfer internal constructor(invitation: Invitation, http: OkHttpClient, onUpdate: (TransferUpdate) -> Unit) : TransferOperation(invitation, http, onUpdate) {
    /** Return a sink only AFTER explicit user consent. null rejects without opening a sink. */
    fun run(onOffer: (TransferOffer) -> TransferSink?): VerifiedFile {
        val nonce = Crypto.random(32)
        val join = JSONObject().put("type", "join").put("protocol", "cd-transfer-v2").put("role", "receiver")
            .put("receiverNonce", Crypto.encode(nonce)).put("receiverToken", Crypto.encode(invitation.token())).put("nonceProof", Crypto.encode(invitation.proof("receiver", nonce)))
        var sink: TransferSink? = null
        var committed = false
        var failure: Throwable? = null
        try {
            return execute(join) { wire ->
                var paired = wire.json(20)
                while (paired.optString("sessionNonce").isEmpty() || paired.optString("receiverNonce").isEmpty()) paired = wire.json(20)
                val expiry = paired.getLong("expiresAt")
                expire(expiry)
                require(Crypto.decode(paired.getString("receiverNonce"), 32).contentEquals(nonce))
                val sender = Crypto.decode(paired.getString("sessionNonce"), 32)
                require(MessageDigest.isEqual(Crypto.decode(paired.getString("senderNonceProof"), 32), invitation.proof("sender", sender)))
                val opener = Records(invitation, sender, nonce, true)
                val sealer = Records(invitation, sender, nonce, false)
                val record = next(wire, opener)
                require(record.first == 1) { "Missing offer" }
                val json = JSONObject(String(record.second))
                val offer = OrdinaryOffer.parse(json)
                require(offer.chunkSize == SendProtocol.CHUNK && json.getLong("expiresAt") == expiry)
                val digest = json.getString("wholeSha256")
                require(digest.matches(Regex("[a-f0-9]{64}"))) { "Invalid digest" }
                val attribution = json.optString("appId").takeIf { it.isNotEmpty() }
                require(attribution == null || attribution.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))) { "Invalid public appId" }
                update(TransferState.AWAITING_CONSENT, 0, offer.size)
                val destination = onOffer(TransferOffer(offer.name, offer.size, digest, expiry, attribution))
                sink = destination
                active()
                if (destination == null) {
                    wire.send(sealer.seal(4, JSONObject().put("rejected", true).toString().toByteArray()))
                    wire.finish()
                    throw TransferException(TransferState.REJECTED)
                }
                val result = VerifiedFile(offer.size, digest)
                destination.open().use { output ->
                    attach(output); active()
                    val accept = JSONObject().put("offset", "0").put("prefixSha256", Crypto.hex(Crypto.sha(byteArrayOf()))).put("ackEveryBytes", SendProtocol.CHUNK)
                    wire.send(sealer.seal(4, accept.toString().toByteArray()))
                    LiveContent.receive(offer.size, digest, 0, MessageDigest.getInstance("SHA-256"),
                        { next(wire, opener) }, output::write, { output.flush() }, { _, _ -> true },
                        { kind, bytes -> wire.send(sealer.seal(kind, bytes)) }, ::active,
                        { update(TransferState.TRANSFERRING, it, offer.size) },
                        { update(TransferState.VERIFYING, offer.size, offer.size) },
                        { output.close(); attach(null); active(); destination.commit(result); committed = true; markPublished(result) })
                }
                // Content is already verified and committed. Losing the final relay ACK cannot undo that.
                runCatching {
                    wire.send(JSONObject().put("type", "complete").put("protocol", "cd-transfer-v2").put("sessionNonce", paired.getString("sessionNonce")).put("receiverNonce", paired.getString("receiverNonce")))
                    while (wire.json(10).getString("type") != "completed") { active() }
                }
                result
            }
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            if (!committed) try { sink?.abort() } catch (cleanup: Throwable) {
                if (failure == null) throw cleanup else failure.addSuppressed(cleanup)
            }
        }
    }
}
