package `in`.yash0.cd.data

import java.security.SecureRandom

/** Funny-word P2P rendezvous codes shared with the web client (must match src/p2p-code.js). */
object FunCodes {
    val Words = listOf(
        "sus", "lit", "mid", "lol", "oof", "omg", "tbh", "smh", "idk", "idc",
        "afk", "brb", "bro", "bae", "cap", "tea", "nap", "lag", "pwn", "dub",
        "arc", "npc", "bet", "ong", "kek", "uwu", "owo", "boi", "bop", "rip",
        "ggs", "aww", "eww", "nom", "yum", "sis",
        "yeet", "rizz", "bruh", "drip", "vibe", "buss", "gyat", "skib", "ohio", "aura",
        "goat", "yolo", "swag", "lmao", "rofl", "woot", "goof", "derp", "bonk", "boop",
        "beep", "womp", "slay", "chad", "beta", "main", "lore", "meme", "noob", "smol",
        "bork", "woof", "meow", "purr", "loaf", "blep", "mlem", "rawr", "dino", "oops",
        "frfr", "lowk", "simp", "flex", "wild", "taco", "boba", "vent", "task", "haha",
        "hehe", "fart", "burp", "poop", "fomo", "sour",
        "vibes", "zesty", "goofy", "chonk", "snoot", "beans", "yikes", "mogus", "sussy", "sigma",
        "alpha", "grass", "ratio", "based", "cheez", "fries", "ramen", "pizza", "snack", "pwned",
        "gobbo", "feral", "chaos", "canon", "spicy", "sweet", "sauce", "salty", "highk", "derpy",
        "howdy", "aloha", "shrek",
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
