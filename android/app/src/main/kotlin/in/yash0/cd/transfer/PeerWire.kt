package `in`.yash0.cd.transfer

import `in`.yash0.cd.data.FileMeta
import `in`.yash0.cd.data.Manifest
import `in`.yash0.cd.data.Wire
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.msgpack.core.MessagePack
import org.msgpack.value.Value
import java.util.UUID

/** Decoded data-channel frame: a control map or raw file bytes. */
sealed interface PeerFrame {
    data class Control(val fields: Map<String, Any?>) : PeerFrame
    data class Bytes(val bytes: ByteArray) : PeerFrame {
        override fun equals(other: Any?): Boolean =
            other is Bytes && bytes.contentEquals(other.bytes)
        override fun hashCode(): Int = bytes.contentHashCode()
    }
}

/**
 * PeerJS-compatible data-channel framing.
 *
 * Ground truth: peerjs@1.5.5 BinarySerializer (see web node_modules).
 * With `serialization:'binary'` — which the web app always uses — EVERY frame
 * is msgpack-packed binary, including `{type:'manifest'}` control objects.
 * Payloads over [CHUNK_MTU] are split into `{__peerData,n,data,total}` chunks
 * that must be reassembled before unpacking.
 */
object PeerWire {
    /** PeerJS chunkedMTU: payloads bigger than this are split. */
    const val CHUNK_MTU = 16300
    const val DC_PREFIX = "dc_"
    const val SIGNALING_VERSION = "1.5.5"

    fun newConnectionId(): String =
        DC_PREFIX + UUID.randomUUID().toString().replace("-", "").take(12)

    // ---------- outbound packing ----------

    private fun packInto(packer: org.msgpack.core.MessagePacker, v: Any?) {
        when (v) {
            null -> packer.packNil()
            is Boolean -> packer.packBoolean(v)
            is Int -> packer.packInt(v)
            is Long -> packer.packLong(v)
            is String -> packer.packString(v)
            is ByteArray -> {
                packer.packBinaryHeader(v.size)
                packer.writePayload(v)
            }
            is Map<*, *> -> {
                packer.packMapHeader(v.size)
                v.forEach { (k, value) ->
                    packer.packString(k as String)
                    packInto(packer, value)
                }
            }
            is List<*> -> {
                packer.packArrayHeader(v.size)
                v.forEach { packInto(packer, it) }
            }
            else -> packer.packString(v.toString())
        }
    }

    fun packRaw(value: Any?): ByteArray {
        val packer = MessagePack.newDefaultBufferPacker()
        packInto(packer, value)
        packer.flush()
        val out = packer.toByteArray()
        packer.close()
        return out
    }

    /**
     * Pack a value into one or more data-channel frames, applying PeerJS
     * chunking when the packed form exceeds [CHUNK_MTU].
     */
    fun packFrames(value: Any?): List<ByteArray> {
        val packed = packRaw(value)
        if (packed.size <= CHUNK_MTU) return listOf(packed)
        val total = (packed.size + CHUNK_MTU - 1) / CHUNK_MTU
        val id = nextChunkId()
        val frames = ArrayList<ByteArray>(total)
        var n = 0
        var off = 0
        while (off < packed.size) {
            val end = minOf(packed.size, off + CHUNK_MTU)
            val slice = packed.copyOfRange(off, end)
            frames.add(
                packRaw(
                    mapOf(
                        "__peerData" to id,
                        "n" to n,
                        "data" to slice,
                        "total" to total,
                    ),
                ),
            )
            n++
            off = end
        }
        return frames
    }

    fun packControl(fields: Map<String, Any?>): List<ByteArray> = packFrames(fields)

    fun packBytes(bytes: ByteArray, offset: Int = 0, len: Int = bytes.size): List<ByteArray> =
        packFrames(if (offset == 0 && len == bytes.size) bytes else bytes.copyOfRange(offset, offset + len))

    @Volatile
    private var chunkId = 1L

    @Synchronized
    private fun nextChunkId(): Long = chunkId++

    // ---------- inbound unpacking + reassembly ----------

    private fun valueToAny(v: Value): Any? = when {
        v.isNilValue -> null
        v.isBooleanValue -> v.asBooleanValue().boolean
        v.isIntegerValue -> v.asIntegerValue().asLong()
        v.isFloatValue -> v.asFloatValue().toDouble()
        v.isStringValue -> v.asStringValue().asString()
        v.isBinaryValue -> v.asBinaryValue().asByteArray()
        v.isArrayValue -> v.asArrayValue().list().map { valueToAny(it) }
        v.isMapValue -> v.asMapValue().map().entries.associate { (k, value) ->
            (if (k.isStringValue) k.asStringValue().asString() else k.toString()) to valueToAny(value)
        }
        else -> v.toString()
    }

    private fun toFrame(v: Value): PeerFrame? = when {
        v.isMapValue -> {
            @Suppress("UNCHECKED_CAST")
            PeerFrame.Control(valueToAny(v) as Map<String, Any?>)
        }
        v.isBinaryValue -> PeerFrame.Bytes(v.asBinaryValue().asByteArray())
        else -> null
    }

    /** Feeds raw data-channel messages; returns a completed frame when ready. */
    class Reassembler {
        private data class Acc(val total: Int, val parts: MutableMap<Int, ByteArray> = mutableMapOf())
        private val pending = mutableMapOf<Long, Acc>()

        fun feed(frame: ByteArray): PeerFrame? {
            val value = runCatching {
                MessagePack.newDefaultUnpacker(frame).use { it.unpackValue() }
            }.getOrNull() ?: return null
            if (!value.isMapValue) return toFrame(value)
            @Suppress("UNCHECKED_CAST")
            val map = valueToAny(value) as Map<String, Any?>
            val id = (map["__peerData"] as? Long) ?: return PeerFrame.Control(map)
            val n = (map["n"] as? Long)?.toInt() ?: return null
            val total = (map["total"] as? Long)?.toInt() ?: return null
            val data = map["data"] as? ByteArray ?: return null
            val acc = pending.getOrPut(id) { Acc(total) }
            acc.parts[n] = data
            if (acc.parts.size < acc.total) return null
            pending.remove(id)
            val ordered = (0 until acc.total).map { acc.parts[it] ?: return null }
            val size = ordered.sumOf { it.size }
            val joined = ByteArray(size)
            var off = 0
            ordered.forEach {
                it.copyInto(joined, off)
                off += it.size
            }
            val inner = runCatching {
                MessagePack.newDefaultUnpacker(joined).use { it.unpackValue() }
            }.getOrNull() ?: return PeerFrame.Bytes(joined)
            return toFrame(inner)
        }
    }

    // ---------- app control maps (same keys as web JSON) ----------

    fun manifestMap(m: Manifest): Map<String, Any?> = mapOf(
        "type" to Wire.MANIFEST,
        "totalFiles" to m.totalFiles.toLong(),
        "totalSize" to m.totalSize,
        "files" to m.files.map {
            mapOf(
                "index" to it.index.toLong(),
                "name" to it.name,
                "size" to it.size,
                "mimeType" to it.mimeType,
            )
        },
    )

    fun parseManifest(map: Map<String, Any?>): Manifest? {
        if (map["type"] != Wire.MANIFEST) return null
        @Suppress("UNCHECKED_CAST")
        val files = (map["files"] as? List<Map<String, Any?>>) ?: return null
        return Manifest(
            totalFiles = (map["totalFiles"] as? Long)?.toInt() ?: files.size,
            totalSize = (map["totalSize"] as? Long) ?: files.sumOf { (it["size"] as? Long) ?: 0L },
            files = files.mapIndexed { i, f ->
                FileMeta(
                    index = (f["index"] as? Long)?.toInt() ?: i,
                    name = f["name"] as? String ?: "file",
                    size = (f["size"] as? Long) ?: 0L,
                    mimeType = f["mimeType"] as? String ?: "application/octet-stream",
                )
            },
        )
    }

    fun fileStartMap(index: Int): Map<String, Any?> = mapOf("type" to Wire.FILE_START, "index" to index.toLong())
    fun fileCompleteMap(index: Int): Map<String, Any?> = mapOf("type" to Wire.FILE_COMPLETE, "index" to index.toLong())
    fun transferCompleteMap(): Map<String, Any?> = mapOf("type" to Wire.TRANSFER_COMPLETE)
    fun transferAckMap(): Map<String, Any?> = mapOf("type" to Wire.TRANSFER_ACK)
    fun progressMap(bytes: Long): Map<String, Any?> = mapOf("type" to Wire.PROGRESS, "bytes" to bytes)
    fun cancelMap(): Map<String, Any?> = mapOf("type" to Wire.CANCEL)

    fun controlType(map: Map<String, Any?>): String? = map["type"] as? String
    fun fileIndex(map: Map<String, Any?>): Int = ((map["index"] as? Long) ?: 0L).toInt()
    fun progressBytes(map: Map<String, Any?>): Long = (map["bytes"] as? Long) ?: 0L

    // ---------- signaling envelopes (exact peerjs shapes) ----------

    fun wsUrl(host: String, port: Int, path: String, key: String, id: String, token: String, secure: Boolean): String {
        val scheme = if (secure) "wss" else "ws"
        return "$scheme://$host:$port${path}peerjs?key=$key&id=$id&token=$token&version=$SIGNALING_VERSION"
    }

    fun heartbeat(): String = buildJsonObject { put("type", "HEARTBEAT") }.toString()

    fun offerEnvelope(to: String, connectionId: String, sdp: String, label: String): String =
        buildJsonObject {
            put("type", "OFFER")
            put("dst", to)
            put("payload", buildJsonObject {
                put("sdp", buildJsonObject {
                    put("type", "offer")
                    put("sdp", sdp)
                })
                put("type", "data")
                put("connectionId", connectionId)
                put("label", label)
                put("reliable", true)
                put("serialization", "binary")
            })
        }.toString()

    fun answerEnvelope(to: String, connectionId: String, sdp: String): String =
        buildJsonObject {
            put("type", "ANSWER")
            put("dst", to)
            put("payload", buildJsonObject {
                put("sdp", buildJsonObject {
                    put("type", "answer")
                    put("sdp", sdp)
                })
                put("type", "data")
                put("connectionId", connectionId)
            })
        }.toString()

    fun candidateEnvelope(to: String, connectionId: String, candidate: String, sdpMid: String?, sdpMLineIndex: Int): String =
        buildJsonObject {
            put("type", "CANDIDATE")
            put("dst", to)
            put("payload", buildJsonObject {
                put("candidate", buildJsonObject {
                    put("candidate", candidate)
                    if (sdpMid != null) put("sdpMid", sdpMid)
                    put("sdpMLineIndex", sdpMLineIndex)
                })
                put("type", "data")
                put("connectionId", connectionId)
            })
        }.toString()

    /** Parses an inbound server message into a typed event. */
    fun parseServerMessage(text: String): ServerEvent {
        val json = Json { ignoreUnknownKeys = true }
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            ?: return ServerEvent.Unknown
        return when (obj["type"]?.jsonPrimitive?.content) {
            "OPEN" -> ServerEvent.Open
            "OFFER" -> {
                val src = obj["src"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown
                val p = obj["payload"]?.jsonObject ?: return ServerEvent.Unknown
                if ((p["type"]?.jsonPrimitive?.content) != "data") return ServerEvent.Unknown
                val sdpObj = p["sdp"]?.jsonObject ?: return ServerEvent.Unknown
                ServerEvent.Offer(
                    from = src,
                    connectionId = p["connectionId"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                    sdp = sdpObj["sdp"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                    label = p["label"]?.jsonPrimitive?.content,
                    serialization = p["serialization"]?.jsonPrimitive?.content,
                )
            }
            "ANSWER" -> {
                val src = obj["src"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown
                val p = obj["payload"]?.jsonObject ?: return ServerEvent.Unknown
                val sdpObj = p["sdp"]?.jsonObject ?: return ServerEvent.Unknown
                ServerEvent.Answer(
                    from = src,
                    connectionId = p["connectionId"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                    sdp = sdpObj["sdp"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                )
            }
            "CANDIDATE" -> {
                val src = obj["src"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown
                val p = obj["payload"]?.jsonObject ?: return ServerEvent.Unknown
                val c = p["candidate"]?.jsonObject ?: return ServerEvent.Unknown
                ServerEvent.Candidate(
                    from = src,
                    connectionId = p["connectionId"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                    candidate = c["candidate"]?.jsonPrimitive?.content ?: return ServerEvent.Unknown,
                    sdpMid = c["sdpMid"]?.jsonPrimitive?.content,
                    sdpMLineIndex = c["sdpMLineIndex"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                )
            }
            "ERROR" -> ServerEvent.Error(obj["payload"]?.jsonObject?.get("msg")?.jsonPrimitive?.content ?: "signaling error")
            "ID-TAKEN" -> ServerEvent.IdTaken
            "INVALID-KEY" -> ServerEvent.InvalidKey
            "LEAVE", "EXPIRE" -> ServerEvent.PeerGone(obj["src"]?.jsonPrimitive?.content ?: "")
            else -> ServerEvent.Unknown
        }
    }

    sealed interface ServerEvent {
        data object Open : ServerEvent
        data class Offer(val from: String, val connectionId: String, val sdp: String, val label: String?, val serialization: String?) : ServerEvent
        data class Answer(val from: String, val connectionId: String, val sdp: String) : ServerEvent
        data class Candidate(val from: String, val connectionId: String, val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int) : ServerEvent
        data class Error(val message: String) : ServerEvent
        data object IdTaken : ServerEvent
        data object InvalidKey : ServerEvent
        data class PeerGone(val peerId: String) : ServerEvent
        data object Unknown : ServerEvent
    }
}
