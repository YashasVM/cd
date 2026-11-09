package `in`.yash0.cd.sdk

import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A separate Node process runs the packaged web API against the same real relay. */
class WebInteropTest {
    private lateinit var root: File
    private lateinit var http: OkHttpClient
    private lateinit var client: CdTransferClient
    private val worker = Executors.newSingleThreadExecutor()
    private val processes = mutableListOf<Process>()
    private val operations = mutableListOf<TransferOperation>()
    private val bytes = ByteArray(5 * 1024 * 1024 + 731) { (it % 251).toByte() }
    private val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    @Before fun setup() {
        assumeNotNull(System.getenv("CD_SDK_RELAY"), System.getenv("CD_SDK_WEB_PEER"))
        root = kotlin.io.path.createTempDirectory("cd-web-interop-").toFile()
        http = OkHttpClient()
        client = CdTransferClient("com.example.android-peer", requireNotNull(System.getenv("CD_SDK_RELAY")), http)
    }
    @After fun cleanup() {
        operations.forEach { it.close() }; processes.forEach { it.destroyForcibly() }; worker.shutdownNow()
        if (::http.isInitialized) { http.dispatcher.cancelAll(); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdownNow() }
        if (::root.isInitialized) root.deleteRecursively()
    }
    private fun peer(mode: String): Process = ProcessBuilder("node", System.getenv("CD_SDK_WEB_PEER"), mode, System.getenv("CD_SDK_RELAY"), File(root, "link").path, File(root, "result").path)
        .redirectErrorStream(true).redirectOutput(File(root, "peer.log")).start().also { processes.add(it) }
    private fun result(process: Process): JSONObject {
        assertTrue("Web peer timed out", process.waitFor(20, TimeUnit.SECONDS))
        assertEquals("Web peer failed", 0, process.exitValue())
        return JSONObject(File(root, "result").readText())
    }
    @Test fun webSenderToAndroidSinkVerifiesEveryByteAndDigest() {
        val peer = peer("send")
        val invitation = File(root, "link")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!invitation.exists() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue("Web sender did not publish an invitation", invitation.exists())
        val op = client.incoming(invitation.readText()).also { operations.add(it) }
        val output = ByteArrayOutputStream()
        var committed = false
        val received = op.run { object : TransferSink {
            override fun open() = output
            override fun commit(file: VerifiedFile) { committed = true; assertEquals(digest, file.sha256) }
            override fun abort() { fail("Unexpected abort") }
        } }
        assertTrue(committed); assertArrayEquals(bytes, output.toByteArray())
        assertEquals(VerifiedFile(bytes.size.toLong(), digest), received)
        assertEquals("complete", result(peer).getString("state"))
    }
    @Test fun androidSenderToWebSinkVerifiesEveryByteAndDigest() {
        val op = client.outgoing(TransferSource("interop.bin", bytes.size.toLong(), digest) { ByteArrayInputStream(bytes) }).also { operations.add(it) }
        val ready = CompletableFuture<String>()
        val sending = worker.submit<VerifiedFile> { op.run { ready.complete(it) } }
        File(root, "link").writeText(ready.get(10, TimeUnit.SECONDS))
        val peer = peer("receive")
        val received = result(peer)
        assertEquals("complete", received.getString("state")); assertEquals(digest, received.getString("sha256"))
        assertEquals(VerifiedFile(bytes.size.toLong(), digest), sending.get(10, TimeUnit.SECONDS))
    }
    @Test fun webRejectionStopsAndroidSenderWithoutOpeningSource() {
        var opened = false
        val op = client.outgoing(TransferSource("interop.bin", bytes.size.toLong(), digest) { opened = true; ByteArrayInputStream(bytes) }).also { operations.add(it) }
        val ready = CompletableFuture<String>()
        val sending = worker.submit<VerifiedFile> { op.run { ready.complete(it) } }
        File(root, "link").writeText(ready.get(10, TimeUnit.SECONDS))
        assertEquals("rejected", result(peer("reject")).getString("state"))
        val failure = assertThrows(java.util.concurrent.ExecutionException::class.java) { sending.get(10, TimeUnit.SECONDS) }
        assertEquals(TransferState.REJECTED, (failure.cause as TransferException).state)
        assertFalse(opened)
    }
}
