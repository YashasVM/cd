package `in`.yash0.cd

import org.json.JSONObject

data class OrdinaryOffer(val name: String, val size: Long, val chunkSize: Int) {
    fun checkChunk(written: Long, length: Int) {
        require(length in 1..chunkSize && written + length <= size && (length == chunkSize || written + length == size)) { "Invalid chunk bounds" }
    }
    companion object {
        fun filename(raw: String): String {
            val safe = raw.map { if (it == '/' || it == '\\' || Character.isISOControl(it)) '_' else it }.joinToString("")
            var end = 0
            var bytes = 0
            while (end < safe.length) {
                val next = end + Character.charCount(safe.codePointAt(end))
                val length = safe.substring(end, next).toByteArray().size
                if (bytes + length > 255) break
                bytes += length
                end = next
            }
            return safe.substring(0, end).takeUnless { it in listOf("", ".", "..") } ?: "file"
        }
        fun parse(json: JSONObject): OrdinaryOffer {
            val name = json.getString("name")
            require(name.toByteArray().size in 1..255 && name !in listOf(".", "..") && name.none { it == '/' || it == '\\' || it.code < 32 }) { "Unsafe filename" }
            val size = json.getString("size")
            require(size.matches(Regex("0|[1-9][0-9]*")) && size.toLong() in 0..9007199254740991L) { "Invalid file size" }
            val chunkSize = json.getInt("chunkSize")
            require(chunkSize in listOf(65536, 262144, 786432)) { "Unsupported chunk size" }
            return OrdinaryOffer(name, size.toLong(), chunkSize)
        }
    }
}
