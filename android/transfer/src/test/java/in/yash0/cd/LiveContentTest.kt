package `in`.yash0.cd

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.ArrayDeque

class LiveContentTest {
    private val bytes = ByteArray(3 * SendProtocol.CHUNK + 731) { (it % 251).toByte() }
    private val digest = Crypto.hex(Crypto.sha(bytes))
    @Test fun resumedSenderChecksRetainedPrefixAndSendsOnlySuffix() {
        val offset = 2L * SendProtocol.CHUNK
        val prefix = bytes.copyOf(offset.toInt())
        val accept = JSONObject().put("offset", offset.toString()).put("prefixSha256", Crypto.hex(Crypto.sha(prefix)))
        val received = ByteArrayOutputStream().apply { write(prefix) }
        val replies = ArrayDeque<Pair<Int, ByteArray>>()
        var verified = false
        LiveContent.send(ByteArrayInputStream(bytes), bytes.size.toLong(), digest, accept,
            seal = { kind, data, length -> byteArrayOf(kind.toByte()) + data.copyOf(length) },
            relay = { record ->
                when (record[0].toInt()) {
                    2 -> { received.write(record, 1, record.size - 1); replies.add(5 to counts(received.size().toLong())) }
                    3 -> { assertArrayEquals(SendProtocol.end(bytes.size.toLong(), digest), record.copyOfRange(1, record.size)); replies.add(6 to record.copyOfRange(1, record.size)); verified = true }
                    else -> fail("Unexpected record")
                }
            }, next = { replies.removeFirst() }, active = {}, progress = { _, _ -> }, verifying = {})
        assertTrue(verified); assertArrayEquals(bytes, received.toByteArray())
        assertThrows(IllegalArgumentException::class.java) {
            LiveContent.send(ByteArrayInputStream(bytes), bytes.size.toLong(), digest, accept.put("prefixSha256", "0".repeat(64)),
                { _, _, _ -> error("No bytes may be sent") }, { fail("No bytes may be sent") }, { error("No ACK expected") }, {}, { _, _ -> }, {})
        }
    }
    @Test fun resumedReceiverPersistsBeforeAckAndPublishesBeforeComplete() {
        val offset = 2L * SendProtocol.CHUNK
        val prefix = bytes.copyOf(offset.toInt())
        val whole = MessageDigest.getInstance("SHA-256").apply { update(prefix) }
        val output = ByteArrayOutputStream().apply { write(prefix) }
        val records = ArrayDeque<Pair<Int, ByteArray>>()
        bytes.copyOfRange(offset.toInt(), bytes.size).asList().chunked(SendProtocol.CHUNK).forEach { records.add(2 to it.toByteArray()) }
        records.add(3 to SendProtocol.end(bytes.size.toLong(), digest))
        var committed = offset
        var published = false
        var completed = false
        LiveContent.receive(bytes.size.toLong(), digest, offset, whole, { records.removeFirst() }, output::write,
            commit = { committed = it }, shouldCommit = { _, _ -> true },
            send = { kind, payload ->
                if (kind == 5) assertArrayEquals(counts(committed), payload)
                else { assertEquals(6, kind); assertTrue(published); assertEquals(bytes.size.toLong(), committed); completed = true }
            }, active = {}, progress = {}, verifying = {}, publish = { assertArrayEquals(bytes, output.toByteArray()); published = true })
        assertTrue(completed)
        // The digest remains available to the host's durable checkpoint adapter.
        assertEquals(digest, Crypto.hex((whole.clone() as MessageDigest).digest()))
    }
    @Test fun receiverRejectsWrongDigestEvenWhenTerminalCountsMatch() {
        val changed = bytes.clone().also { it[0] = 99 }
        val records = ArrayDeque<Pair<Int, ByteArray>>()
        changed.asList().chunked(SendProtocol.CHUNK).forEach { records.add(2 to it.toByteArray()) }
        records.add(3 to SendProtocol.end(bytes.size.toLong(), digest))
        var published = false
        assertThrows(IllegalArgumentException::class.java) {
            LiveContent.receive(bytes.size.toLong(), digest, 0, MessageDigest.getInstance("SHA-256"),
                { records.removeFirst() }, {}, {}, { _, _ -> true },
                { kind, _ -> assertEquals(5, kind) }, {}, {}, {}, { published = true })
        }
        assertFalse(published)
    }

}
