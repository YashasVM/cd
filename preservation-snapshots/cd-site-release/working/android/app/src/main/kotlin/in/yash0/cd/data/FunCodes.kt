package `in`.yash0.cd.data

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

    fun generate(): String = Words[secureRandom.nextInt(Words.size)]

    fun normalize(code: String): String {
        val lower = code.lowercase()
        return if (wordSet.contains(lower)) lower else code
    }

    fun clean(raw: String?): String =
        (raw ?: "").trim().filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(MaxLength)

    fun isValid(raw: String?): Boolean {
        if (raw == null) return false
        if (wordSet.contains(raw.lowercase())) return true
        return legacy8.matches(raw) || legacy22.matches(raw)
    }

    /** Accepts a pasted full link or a bare code, like web codeFromUrl(). */
    fun fromLinkOrCode(raw: String): String {
        if (raw.isBlank()) return ""
        val trimmed = raw.trim()
        if (isValid(trimmed)) return normalize(trimmed)
        val fragment = Regex("""#p2p\.([A-Za-z0-9_-]{1,22})""").find(raw)?.groupValues?.get(1)
        val cleaned = clean(fragment ?: "")
        if (isValid(cleaned)) return normalize(cleaned)
        return ""
    }

    fun peerIdFor(code: String): String = "cd-${normalize(code)}"
}
