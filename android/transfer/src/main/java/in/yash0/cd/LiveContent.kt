package `in`.yash0.cd

import java.io.InputStream
import java.io.IOException
import java.security.MessageDigest

class SourceChangedException : IOException("Source changed")

class ReceiverRejectedException : IOException("Receiver rejected transfer")

/** Shared v2 stream engine. CD supplies its durable checkpoint and direct-path adapters here. */
object LiveContent {
    /** A direct path may take over only at a fully acknowledged boundary. */
    interface Direct {
        fun ready(): Boolean
        fun markUsed()
        fun send(record: ByteArray)
    }

    fun send(
        source: InputStream, size: Long, digest: String, accept: org.json.JSONObject,
        seal: (Int, ByteArray, Int) -> ByteArray, relay: (ByteArray) -> Unit,
        next: () -> Pair<Int, ByteArray>, active: () -> Unit,
        progress: (Long, Boolean) -> Unit, verifying: () -> Unit, direct: Direct? = null,
    ): ByteArray {
        if (accept.optBoolean("rejected")) throw ReceiverRejectedException()
        val offset = SendProtocol.offset(accept.getString("offset"), size)
        val ackEvery = accept.optLong("ackEveryBytes", SendProtocol.CHUNK.toLong())
        require(ackEvery in SendProtocol.CHUNK.toLong()..SendProtocol.WINDOW && ackEvery % SendProtocol.CHUNK == 0L) { "Invalid ACK interval" }
        val whole = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(SendProtocol.CHUNK)
        var prefix = offset
        while (prefix > 0) {
            active()
            val n = source.read(buffer, 0, minOf(buffer.size.toLong(), prefix).toInt())
            if (n <= 0) throw SourceChangedException()
            whole.update(buffer, 0, n); prefix -= n
        }
        require(Crypto.hex((whole.clone() as MessageDigest).digest()) == accept.getString("prefixSha256")) { "Receiver checkpoint does not match source" }
        var sent = offset
        var ack = offset
        var usingDirect = false
        var draining = false
        progress(offset, false)
        while (ack < size) {
            active()
            if (!usingDirect) {
                if (direct?.ready() != true) draining = false
                else if ((sent - offset) % ackEvery == 0L || sent == size) draining = true
                if (draining && sent == ack) { direct!!.markUsed(); usingDirect = true; draining = false }
            }
            while (sent < size && sent - ack < SendProtocol.WINDOW && !draining) {
                active()
                val n = minOf(buffer.size.toLong(), size - sent).toInt()
                var filled = 0
                while (filled < n) {
                    active()
                    val read = source.read(buffer, filled, n - filled)
                    if (read <= 0) throw SourceChangedException()
                    filled += read
                }
                whole.update(buffer, 0, n)
                val record = seal(2, buffer, n)
                if (usingDirect) direct!!.send(record) else relay(record)
                sent += n
                if (!usingDirect && direct?.ready() == true && ((sent - offset) % ackEvery == 0L || sent == size)) draining = true
            }
            val record = next()
            require(record.first == 5) { "Expected cumulative acknowledgement" }
            ack = SendProtocol.ack(record.second, ack, sent, size)
            progress(ack, usingDirect)
        }
        if (source.read() != -1 || Crypto.hex(whole.digest()) != digest) throw SourceChangedException()
        active(); verifying()
        val end = SendProtocol.end(size, digest)
        relay(seal(3, end, end.size))
        val complete = next()
        require(complete.first == 6 && MessageDigest.isEqual(complete.second, end)) { "Receiver did not verify complete file" }
        return end
    }

    /** write must take ownership before returning; commit must persist bytes before their ACK. */
    fun receive(
        size: Long, digest: String, offset: Long, whole: MessageDigest,
        next: () -> Pair<Int, ByteArray>, write: (ByteArray) -> Unit,
        commit: (Long) -> Unit, shouldCommit: (Long, Long) -> Boolean,
        send: (Int, ByteArray) -> Unit, active: () -> Unit,
        progress: (Long) -> Unit, verifying: () -> Unit, publish: () -> Unit,
        currentDigest: () -> String = { Crypto.hex((whole.clone() as MessageDigest).digest()) },
    ) {
        var written = offset
        var committed = offset
        while (true) {
            active()
            val (kind, data) = next()
            if (kind == 2) {
                require(data.isNotEmpty() && data.size <= SendProtocol.CHUNK && written + data.size <= size && (data.size == SendProtocol.CHUNK || written + data.size == size)) { "Invalid chunk bounds" }
                write(data); whole.update(data); written += data.size
                if (shouldCommit(written, committed)) { commit(written); committed = written; send(5, counts(committed)) }
                progress(committed)
            } else {
                verifying()
                val expected = SendProtocol.end(size, digest)
                require(kind == 3 && written == size && currentDigest() == digest && MessageDigest.isEqual(data, expected)) { "Final digest or size failed verification" }
                if (committed != written) commit(written)
                active(); publish(); active()
                send(6, expected)
                return
            }
        }
    }
}
