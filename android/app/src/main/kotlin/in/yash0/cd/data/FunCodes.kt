package `in`.yash0.cd.data

import java.security.SecureRandom
import java.util.Base64

/** 128-bit, URL-safe P2P rendezvous codes shared with the web client. */
object FunCodes {
    const val Length = 22
    private val secureRandom = SecureRandom()
    private val pattern = Regex("^[A-Za-z0-9_-]{$Length}$")

    fun generate(): String {
        val bytes = ByteArray(16)
        secureRandom.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
    fun clean(raw: String?): String =
        (raw ?: "").trim().filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(Length)

    fun isValid(raw: String?): Boolean = raw != null && pattern.matches(raw)

    /** Accepts a pasted full link or a bare code, like web codeFromUrl(). */
    fun fromLinkOrCode(raw: String): String {
        if (raw.isBlank()) return ""
        if (isValid(raw.trim())) return raw.trim()
        val fragment = Regex("""#p2p\.([A-Za-z0-9_-]{$Length})""").find(raw)?.groupValues?.get(1)
        return clean(fragment ?: "")
    }

    fun peerIdFor(code: String): String = "cd-$code"
}
