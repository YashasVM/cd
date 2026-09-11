package `in`.yash0.cd.data

import kotlin.random.Random

/** Same friendly dictionary as web src/main.js FUN_CODES. */
object FunCodes {
    val All = listOf(
        "beep", "boop", "bork", "bonk", "blob", "cake", "clam", "clap", "dino", "drip",
        "duck", "flap", "goof", "honk", "jazz", "mochi", "muffin", "nacho", "noodle",
        "otter", "pickle", "pizza", "plop", "quack", "salsa", "snack", "spork", "taco",
        "tofu", "wacky", "waffle", "yeti", "zippy",
    )
    val MaxLength = All.maxOf { it.length }

    fun generate(): String = All[Random.nextInt(All.size)]
    fun clean(raw: String?): String =
        (raw ?: "").lowercase().filter { it.isLetterOrDigit() }.take(MaxLength)

    fun isValid(raw: String?): Boolean = All.contains(clean(raw))

    /** Accepts a pasted full link or a bare code, like web codeFromUrl(). */
    fun fromLinkOrCode(raw: String): String {
        if (raw.isBlank()) return ""
        val query = Regex("[?&]receive=([^&\\s]+)").find(raw)?.groupValues?.get(1)
        return clean(query ?: raw.substringAfterLast('/'))
    }

    fun peerIdFor(code: String): String = "cd-" + clean(code)
}
