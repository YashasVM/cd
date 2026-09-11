package `in`.yash0.cd

import `in`.yash0.cd.data.FileMeta
import `in`.yash0.cd.data.FunCodes
import `in`.yash0.cd.data.Manifest
import `in`.yash0.cd.data.TransferProgress
import `in`.yash0.cd.data.Wire
import `in`.yash0.cd.transfer.PeerFrame
import `in`.yash0.cd.transfer.PeerWire
import `in`.yash0.cd.transfer.TransferProtocol
import `in`.yash0.cd.util.formatSize
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Locks in web parity (src/main.js) + the peerjs@1.5.5 wire shapes.
 * Pure JVM — no Android framework needed.
 */
class TransferLogicTest {
    private val json = Json { ignoreUnknownKeys = true }

    // ---------- fun codes (must match web FUN_CODES) ----------

    @Test fun funCodes_matchWebDictionary() {
        val web = listOf(
            "beep", "boop", "bork", "bonk", "blob", "cake", "clam", "clap", "dino", "drip",
            "duck", "flap", "goof", "honk", "jazz", "mochi", "muffin", "nacho", "noodle",
            "otter", "pickle", "pizza", "plop", "quack", "salsa", "snack", "spork", "taco",
            "tofu", "wacky", "waffle", "yeti", "zippy",
        )
        assertEquals(web, FunCodes.All)
    }

    @Test fun funCodes_generateCleanValidate() {
        repeat(50) { assertTrue(FunCodes.isValid(FunCodes.generate())) }
        assertEquals("waffle", FunCodes.clean("  Waffle!!"))
        assertEquals("pickle", FunCodes.clean("picklehead").take(6))
        assertTrue(FunCodes.isValid("TACO"))
    }

    @Test fun funCodes_fromLinkOrCode() {
        assertEquals("dino", FunCodes.fromLinkOrCode("https://cd.yash0.in/?receive=dino"))
        assertEquals("dino", FunCodes.fromLinkOrCode("dino"))
        assertEquals("cd-waffle", FunCodes.peerIdFor("waffle"))
    }

    // ---------- protocol constants ----------

    @Test fun chunkSize_matchesWeb() {
        assertEquals(16 * 1024 - 128, TransferProtocol.CHUNK_SIZE)
    }

    @Test fun appChunk_staysSinglePeerJsFrame() {
        // Web comment: app chunks stay below the ~16KB MTU to avoid PeerJS
        // fragment/reassembly per chunk. Prove it with real framing.
        val chunk = Random.nextBytes(TransferProtocol.CHUNK_SIZE)
        val frames = PeerWire.packBytes(chunk)
        assertEquals(1, frames.size)
        assertTrue(frames[0].size <= PeerWire.CHUNK_MTU)
    }

    // ---------- formatting ----------

    @Test fun formatSize_units() {
        assertEquals("0 B", formatSize(0))
        assertEquals("512 B", formatSize(512))
        assertEquals("1.0 KB", formatSize(1024))
        assertEquals("1.0 MB", formatSize(1024 * 1024))
        assertEquals("2.00 GB", formatSize(2L * 1024 * 1024 * 1024))
    }

    // ---------- msgpack framing ----------

    @Test fun control_roundTripsThroughMsgpack() {
        val fields = mapOf(
            "type" to Wire.MANIFEST,
            "totalFiles" to 2L,
            "totalSize" to 12345L,
            "note" to "héllo wörld",
            "files" to listOf(mapOf("index" to 0L, "name" to "a b/c+d.txt", "size" to 12L, "mimeType" to "text/plain")),
        )
        val frames = PeerWire.packControl(fields)
        assertEquals(1, frames.size)
        val out = PeerWire.Reassembler().feed(frames[0])
        assertTrue(out is PeerFrame.Control)
        assertEquals(fields, out.fields)
    }

    @Test fun bytes_roundTrip() {
        val bytes = Random.nextBytes(5000)
        val out = PeerWire.Reassembler().feed(PeerWire.packBytes(bytes)[0])
        assertTrue(out is PeerFrame.Bytes)
        assertTrue(bytes.contentEquals(out.bytes))
    }

    @Test fun largePayload_chunksAndReassemblesOutOfOrder() {
        val big = Random.nextBytes(100_000)
        val frames = PeerWire.packBytes(big)
        assertTrue(frames.size > 1)
        val rx = PeerWire.Reassembler()
        var done: PeerFrame? = null
        frames.shuffled().forEach { done = rx.feed(it) ?: done }
        assertTrue(done is PeerFrame.Bytes)
        assertTrue(big.contentEquals((done as PeerFrame.Bytes).bytes))
    }

    @Test fun manifest_roundTrips() {
        val m = Manifest(
            2, 30L,
            listOf(FileMeta(0, "a.txt", 10L, "text/plain"), FileMeta(1, "b.bin", 20L)),
        )
        val frame = PeerWire.packControl(PeerWire.manifestMap(m))[0]
        val out = PeerWire.Reassembler().feed(frame)
        assertTrue(out is PeerFrame.Control)
        assertEquals(m, PeerWire.parseManifest(out.fields))
    }

    @Test fun controlHelpers() {
        assertEquals(Wire.FILE_START, PeerWire.controlType(PeerWire.fileStartMap(2)))
        assertEquals(2, PeerWire.fileIndex(PeerWire.fileStartMap(2)))
        assertEquals(99L, PeerWire.progressBytes(PeerWire.progressMap(99L)))
    }

    // ---------- signaling envelopes ----------

    @Test fun wsUrl_carriesVersionAndIdentity() {
        val url = PeerWire.wsUrl("0.peerjs.com", 443, "/", "peerjs", "cd-waffle", "tok", true)
        assertTrue(url.startsWith("wss://0.peerjs.com:443/peerjs?"))
        assertTrue(url.contains("key=peerjs") && url.contains("id=cd-waffle") && url.contains("token=tok"))
        assertEquals("1.5.5", Regex("version=([^&]+)").find(url)!!.groupValues[1])
        assertEquals(PeerWire.SIGNALING_VERSION, "1.5.5")
    }

    @Test fun heartbeat_shape() {
        assertEquals("HEARTBEAT", json.parseToJsonElement(PeerWire.heartbeat()).jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test fun offerEnvelope_browserRoutable() {
        val env = json.parseToJsonElement(
            PeerWire.offerEnvelope("cd-waffle", "dc_abc123", "v=0\r\n...", "dc_abc123"),
        ).jsonObject
        assertEquals("OFFER", env["type"]!!.jsonPrimitive.content)
        assertEquals("cd-waffle", env["dst"]!!.jsonPrimitive.content)
        val p = env["payload"]!!.jsonObject
        assertEquals("data", p["type"]!!.jsonPrimitive.content)
        assertEquals("dc_abc123", p["connectionId"]!!.jsonPrimitive.content)
        assertEquals("dc_abc123", p["label"]!!.jsonPrimitive.content)
        assertEquals("binary", p["serialization"]!!.jsonPrimitive.content)
        assertEquals("offer", p["sdp"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("v=0\r\n...", p["sdp"]!!.jsonObject["sdp"]!!.jsonPrimitive.content)
    }

    @Test fun answerAndCandidateEnvelopes() {
        val ans = json.parseToJsonElement(PeerWire.answerEnvelope("cd-r-x", "dc_1", "v=0...")).jsonObject
        assertEquals("ANSWER", ans["type"]!!.jsonPrimitive.content)
        assertEquals("answer", ans["payload"]!!.jsonObject["sdp"]!!.jsonObject["type"]!!.jsonPrimitive.content)

        val cand = json.parseToJsonElement(
            PeerWire.candidateEnvelope("cd-r-x", "dc_1", "candidate:1 1 udp 1 1.2.3.4 5000 typ host", "audio", 0),
        ).jsonObject["payload"]!!.jsonObject["candidate"]!!.jsonObject
        assertEquals("candidate:1 1 udp 1 1.2.3.4 5000 typ host", cand["candidate"]!!.jsonPrimitive.content)
        assertEquals("audio", cand["sdpMid"]!!.jsonPrimitive.content)
    }

    @Test fun parseServerMessages() {
        assertTrue(PeerWire.parseServerMessage("""{"type":"OPEN"}""") is PeerWire.ServerEvent.Open)
        assertTrue(PeerWire.parseServerMessage("""{"type":"ID-TAKEN"}""") is PeerWire.ServerEvent.IdTaken)
        assertTrue(PeerWire.parseServerMessage("""{"type":"EXPIRE","src":"cd-x"}""") is PeerWire.ServerEvent.PeerGone)
        val err = PeerWire.parseServerMessage("""{"type":"ERROR","payload":{"msg":"boom"}}""")
        assertEquals("boom", (err as PeerWire.ServerEvent.Error).message)

        val offer = PeerWire.parseServerMessage(
            """{"type":"OFFER","src":"cd-r-1","payload":{"sdp":{"type":"offer","sdp":"SDP"},"type":"data","connectionId":"dc_9","label":"dc_9","reliable":true,"serialization":"binary"}}""",
        ) as PeerWire.ServerEvent.Offer
        assertEquals("cd-r-1", offer.from)
        assertEquals("dc_9", offer.connectionId)
        assertEquals("SDP", offer.sdp)

        // Media offers must be rejected (we are data-only).
        assertTrue(
            PeerWire.parseServerMessage(
                """{"type":"OFFER","src":"x","payload":{"sdp":{"type":"offer","sdp":"s"},"type":"media","connectionId":"mc_1"}}""",
            ) is PeerWire.ServerEvent.Unknown,
        )
    }

    // ---------- progress ----------

    @Test fun progress_math() {
        val p = TransferProgress(50, 200, System.currentTimeMillis() - 1000)
        assertEquals(25, p.percent)
        assertEquals(0.25f, p.fraction)
        assertTrue(p.speedBps > 0)
        assertNotEquals(p, p.copy(bytes = 51))
    }
}
