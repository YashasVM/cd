package `in`.yash0.cd

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.net.InetAddress
import java.net.URI
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Crypto {
    fun encode(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun decode(s: String, length: Int): ByteArray {
        val b = Base64.getUrlDecoder().decode(s)
        require(b.size == length && encode(b) == s) { "Invalid encoded credential" }
        return b
    }
    fun random(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
    fun sha(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun hmac(key: ByteArray, b: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(b) }
    fun derive(secret: ByteArray, salt: ByteArray, info: String): ByteArray = hmac(hmac(salt, secret), info.toByteArray() + byteArrayOf(1))
    fun cipher(encrypt: Boolean, key: ByteArray, nonce: ByteArray, aad: ByteArray, bytes: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        updateAAD(aad); doFinal(bytes)
    }
}

fun localEndpoint(raw: String): Boolean = runCatching {
    val u = URI(raw)
    require(u.scheme == "ws" && u.host != null && u.userInfo == null && u.fragment == null)
    val host = u.host.removePrefix("[").removeSuffix("]")
    require(host.matches(Regex("[0-9.]+")) || host.contains(':'))
    val a = InetAddress.getByName(host)
    a.isSiteLocalAddress || a.isLinkLocalAddress || a.isLoopbackAddress
}.getOrDefault(false)

fun validEndpoint(raw: String): Boolean = runCatching {
    val u = URI(raw)
    (u.scheme == "wss" && u.host != null && u.userInfo == null && u.fragment == null) || localEndpoint(raw)
}.getOrDefault(false)

data class Invitation(val id: String, val key: ByteArray, val relay: String, val version: Int = 2) {
    val rawId: ByteArray get() = Crypto.decode(id, 16)
    fun token(): ByteArray = Crypto.derive(key, rawId, "cd-transfer-v$version receiver join")
    fun proof(role: String, nonce: ByteArray): ByteArray = Crypto.hmac(key, "cd-transfer-v2 $role nonce".toByteArray() + rawId + nonce)
    companion object {
        fun parse(raw: String): Invitation {
            val u = URI(raw.trim())
            require(u.scheme == "https" || (u.scheme == "http" && localEndpoint("ws://${u.rawAuthority}${u.path}")))
            require(u.userInfo == null && u.query == null && u.path.matches(Regex("/s/[A-Za-z0-9_-]{22}")))
            val id = u.path.substringAfterLast('/')
            val fragment = requireNotNull(u.rawFragment) { "Paste the complete CD link, including its key" }
            val version = if (fragment.startsWith("v2.")) 2 else 1
            Crypto.decode(id, 16)
            val key = Crypto.decode(if (version == 2 || fragment.startsWith("v1.")) fragment.substring(3) else fragment, 32)
            val relay = "${if (u.scheme == "https") "wss" else "ws"}://${u.rawAuthority}/ws/v$version/$id"
            require(validEndpoint(relay))
            return Invitation(id, key, relay, version)
        }
    }
}

class Records(private val invitation: Invitation, private val sender: ByteArray, private val receiver: ByteArray, private val fromSender: Boolean) {
    private var sequence = 0L
    private val key = Crypto.derive(invitation.key, invitation.rawId + sender + receiver, "cd-transfer-v${invitation.version} ${if (fromSender) "sender" else "receiver"} frames")
    private val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    private val aesKey = SecretKeySpec(key, "AES")
    private val recordContext = invitation.rawId + sender + receiver
    private fun crypt(encrypt: Boolean, header: ByteArray, bytes: ByteArray, offset: Int = 0): ByteArray {
        cipher.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, nonce()))
        cipher.updateAAD(header)
        cipher.updateAAD(recordContext)
        return cipher.doFinal(bytes, offset, bytes.size - offset)
    }
    private fun nonce(): ByteArray = ByteBuffer.allocate(12).put((if (fromSender) "CDS${invitation.version}" else "CDR${invitation.version}").toByteArray()).putLong(sequence).array()
    private fun validKind(kind: Int): Boolean = if (fromSender) kind in 1..3 else kind in 4..6 || kind == 9
    fun seal(kind: Int, plaintext: ByteArray): ByteArray {
        require(validKind(kind) && sequence <= 0xffffffffL && plaintext.size <= 1048548)
        val header = ByteBuffer.allocate(12).put('C'.code.toByte()).put('D'.code.toByte()).put(invitation.version.toByte()).put(kind.toByte()).putInt(sequence.toInt()).putInt(plaintext.size).array()
        val out = header + crypt(true, header, plaintext)
        sequence++; return out
    }
    fun open(record: ByteArray): Pair<Int, ByteArray> {
        require(record.size in 28..1048576)
        val h = ByteBuffer.wrap(record, 0, 12)
        require(h.get() == 'C'.code.toByte() && h.get() == 'D'.code.toByte() && h.get().toInt() == invitation.version)
        val kind = h.get().toInt() and 255
        require(validKind(kind) && h.int.toLong().and(0xffffffffL) == sequence)
        require(h.int == record.size - 28)
        val out = crypt(false, record.copyOfRange(0, 12), record, 12)
        sequence++; return kind to out
    }
}

fun counts(offset: Long): ByteArray = ByteBuffer.allocate(12).putInt(((offset + 262143) / 262144).toInt()).putLong(offset).array()
fun checkpointMac(j: JSONObject, invitation: Invitation): String {
    val fields = listOf("version", "role", "rootId", "filename", "size", "chunkSize", "wholeSha256", "offset", "prefixSha256", "stagingId", "destination", "expiresAt", "priorSessionNonce")
    val bytes = java.io.ByteArrayOutputStream()
    fields.forEach { f -> val b = j.get(f).toString().toByteArray(); bytes.write(ByteBuffer.allocate(4).putInt(b.size).array()); bytes.write(b) }
    return Crypto.encode(Crypto.hmac(Crypto.derive(invitation.key, invitation.rawId, "cd-transfer-v2 receiver checkpoint"), bytes.toByteArray()))
}
