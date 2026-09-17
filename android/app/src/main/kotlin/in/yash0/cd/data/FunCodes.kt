package `in`.yash0.cd.data

import java.net.URI
import java.net.URISyntaxException
import java.security.SecureRandom

/** Short-word P2P rendezvous codes shared with the web client (must match src/p2p-code.js). */
object FunCodes {
    val Words = listOf(
        "sun", "sky", "sea", "oak", "elm", "fox", "owl", "ant", "bee", "red",
        "cup", "mug", "pen", "map", "key", "box", "jar", "egg", "fig", "pie",
        "tea", "jam", "bus", "car", "gem", "toy", "top", "run",
        "pine", "fern", "moss", "rain", "snow", "leaf", "dune", "reef", "bear", "wolf",
        "lion", "crab", "dove", "hawk", "seal", "swan", "goat", "blue", "lamp", "book",
        "vase", "drum", "bell", "tent", "kite", "desk", "ring", "coin", "kind", "warm",
        "cool", "calm", "moon", "star", "cake", "rice", "bean", "corn", "plum", "pear",
        "kiwi", "jump", "sing",
        "river", "cloud", "bloom", "coral", "pearl", "eagle", "panda", "koala", "otter", "robin",
        "finch", "gecko", "camel", "zebra", "tiger", "horse", "sheep", "mouse", "mango", "lemon",
        "apple", "bread", "honey", "cocoa", "mocha", "latte", "melon", "berry", "peach", "grape",
        "chair", "table", "clock", "frame", "photo", "piano", "flute", "green", "amber", "dance",
        "smile", "laugh", "shine", "happy", "swift", "brave", "fresh", "crisp", "trail", "grove",
    )
    private val wordSet = Words.toSet()
    const val MaxLength = 22
    private val secureRandom = SecureRandom()
    private val legacy8 = Regex("^[A-Za-z0-9_-]{8}$")
    private val legacy22 = Regex("^[A-Za-z0-9_-]{22}$")
    private val cleanPattern = Regex("[^A-Za-z0-9_-]")

    fun generate(): String {
        val index = drawPairIndex()
        return "${Words[index / Words.size]}-${Words[index % Words.size]}"
    }

    private fun drawPairIndex(): Int {
        val space = Words.size * Words.size
        val limit = (1L shl 32) / space * space
        val bytes = ByteArray(4)

        while (true) {
            secureRandom.nextBytes(bytes)
            val value =
                ((bytes[0].toLong() and 0xff) shl 24) +
                    ((bytes[1].toLong() and 0xff) shl 16) +
                    ((bytes[2].toLong() and 0xff) shl 8) +
                    (bytes[3].toLong() and 0xff)
            if (value < limit) return (value % space).toInt()
        }
    }

    fun normalize(code: String): String {
        val lower = code.lowercase()
        return if (wordSet.contains(lower) || isWordPair(lower)) lower else code
    }

    fun clean(raw: String?): String =
        (raw ?: "").trim().replace(cleanPattern, "").take(MaxLength)

    fun isValid(raw: String?): Boolean {
        if (raw == null) return false
        val lower = raw.lowercase()
        if (wordSet.contains(lower) || isWordPair(lower)) return true
        return legacy8.matches(raw) || legacy22.matches(raw)
    }

    /** Accepts a pasted full link or a bare code, like web codeFromUrl(). */
    fun fromLinkOrCode(raw: String): String {
        if (raw.isBlank()) return ""
        val trimmed = raw.trim()
        if (isValid(trimmed)) return normalize(trimmed)

        val fragment = try {
            URI(trimmed).rawFragment
        } catch (_: URISyntaxException) {
            null
        }
        val candidate = if (fragment?.startsWith("p2p.") == true) fragment.substring(5) else ""
        val cleaned = clean(candidate)
        if (isValid(cleaned)) return normalize(cleaned)

        // Match the web fallback for malformed URL input while keeping normal
        // URLs restricted to their actual fragment.
        if (fragment == null) {
            val fallback = clean(trimmed)
            if (isValid(fallback)) return normalize(fallback)
        }
        return ""
    }

    fun peerIdFor(code: String): String {
        require(isValid(code)) { "invalid P2P code" }
        return "cd-${normalize(code)}"
    }

    private fun isWordPair(value: String): Boolean {
        val parts = value.split('-')
        return parts.size == 2 && wordSet.contains(parts[0]) && wordSet.contains(parts[1])
    }
}
