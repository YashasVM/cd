package `in`.yash0.cd.sdk

import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.SocketFactory

/** Real public API + repository Worker/SQLite DOs, launched by scripts/verify-android-sdk.mjs. */
class LiveRelayTest {
    private val worker = Executors.newCachedThreadPool()
    private val clients = mutableListOf<OkHttpClient>()
    private val operations = CopyOnWriteArrayList<TransferOperation>()
    private lateinit var base: String
    private lateinit var root: File
    @Before fun setup() {
        assumeNotNull(System.getenv("CD_SDK_RELAY"))
        base = System.getenv("CD_SDK_RELAY")!!
        root = kotlin.io.path.createTempDirectory("cd-sdk-test-").toFile()
    }
    @After fun cleanup() {
        operations.forEach { it.close() }
        worker.shutdownNow()
        clients.forEach { it.dispatcher.cancelAll(); it.connectionPool.evictAll(); it.dispatcher.executorService.shutdownNow() }
        if (::root.isInitialized) root.deleteRecursively()
    }
    private fun client(factory: SocketFactory? = null): CdTransferClient {
        val http = OkHttpClient.Builder().apply { factory?.let { socketFactory(it) } }.build()
        clients.add(http)
        return CdTransferClient("com.example.host", base, http)
    }
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private val payload get() = ByteArray(5 * 1024 * 1024 + 731) { (it % 251).toByte() }
    private fun source(bytes: ByteArray, open: () -> java.io.InputStream = { ByteArrayInputStream(bytes) }) = TransferSource("archive.zip", bytes.size.toLong(), hash(bytes), open)
    private class Sink(root: File, val failCommit: Boolean = false) : TransferSink {
        val stage = File(root, "${java.util.UUID.randomUUID()}.part")
        val target = File(root, "${java.util.UUID.randomUUID()}.verified")
        var opened = false
        var aborted = false
        override fun open(): OutputStream { opened = true; return stage.outputStream() }
        override fun commit(file: VerifiedFile) { if (failCommit) throw IOException("Host storage failed"); check(stage.renameTo(target)) }
        override fun abort() { aborted = true; stage.delete() }
    }
    private data class Send(val op: OutgoingTransfer, val link: CompletableFuture<String>, val result: java.util.concurrent.Future<VerifiedFile>)
    private fun send(source: TransferSource, lifetime: Long = 60000, onUpdate: (TransferUpdate) -> Unit = {}, factory: SocketFactory? = null): Send {
        val ready = CompletableFuture<String>()
        val op = client(factory).outgoing(source, lifetime, onUpdate).also { operations.add(it) }
        val result = worker.submit<VerifiedFile> { op.run { ready.complete(it) } }
        return Send(op, ready, result)
    }
    private fun receive(link: String, onOffer: (TransferOffer) -> TransferSink?, onUpdate: (TransferUpdate) -> Unit = {}): Pair<IncomingTransfer, java.util.concurrent.Future<VerifiedFile>> {
        val op = client().incoming(link, onUpdate).also { operations.add(it) }
        return op to worker.submit<VerifiedFile> { op.run(onOffer) }
    }
    private fun failure(future: java.util.concurrent.Future<VerifiedFile>): TransferException {
        val error = assertThrows(java.util.concurrent.ExecutionException::class.java) { future.get(15, TimeUnit.SECONDS) }
        return error.cause as TransferException
    }
    @Test fun consentGatesSourceAndExactMultiWindowBytesReachHostStorage() {
        val bytes = payload
        val opened = AtomicBoolean()
        val states = CopyOnWriteArrayList<TransferState>()
        val sending = send(source(bytes) { opened.set(true); ByteArrayInputStream(bytes) }, onUpdate = { states.add(it.state) })
        val link = sending.link.get(10, TimeUnit.SECONDS)
        assertTrue(link.contains("#v2."))
        val offered = CountDownLatch(1)
        val consent = CountDownLatch(1)
        val sink = Sink(root)
        val receiving = receive(link, { offer ->
            assertEquals("com.example.host", offer.appId)
            assertEquals(hash(bytes), offer.sha256)
            offered.countDown(); assertTrue(consent.await(5, TimeUnit.SECONDS)); sink
        })
        assertTrue(offered.await(10, TimeUnit.SECONDS))
        assertFalse(opened.get()); assertFalse(sink.opened)
        consent.countDown()
        val verified = receiving.second.get(20, TimeUnit.SECONDS)
        assertEquals(VerifiedFile(bytes.size.toLong(), hash(bytes)), verified)
        assertArrayEquals(bytes, sink.target.readBytes())
        assertEquals(verified, sending.result.get(10, TimeUnit.SECONDS))
        assertEquals(TransferState.COMPLETE, sending.op.state)
        assertEquals(TransferState.COMPLETE, receiving.first.state)
        assertTrue(states.containsAll(listOf(TransferState.WAITING, TransferState.AWAITING_CONSENT, TransferState.TRANSFERRING, TransferState.VERIFYING)))
        assertThrows(IllegalStateException::class.java) { sending.op.run {} }
    }
    @Test fun emptyFileIsVerified() {
        val bytes = byteArrayOf()
        val sending = send(source(bytes))
        val sink = Sink(root)
        val receiving = receive(sending.link.get(10, TimeUnit.SECONDS), { sink })
        assertEquals(VerifiedFile(0, hash(bytes)), receiving.second.get(10, TimeUnit.SECONDS))
        assertEquals(0L, sink.target.length())
        assertEquals(0L, sending.result.get(10, TimeUnit.SECONDS).size)
    }
    @Test fun rejectNeverOpensSourceOrSinkAndSenderObservesRejection() {
        val opened = AtomicBoolean()
        val sending = send(source(payload) { opened.set(true); ByteArrayInputStream(payload) })
        val receiving = receive(sending.link.get(10, TimeUnit.SECONDS), { null })
        assertEquals(TransferState.REJECTED, failure(receiving.second).state)
        assertEquals(TransferState.REJECTED, failure(sending.result).state)
        assertFalse(opened.get())
    }
    @Test fun senderCancellationWakesWaitAndNeverAdvertisesSuccess() {
        val sending = send(source(payload))
        sending.link.get(10, TimeUnit.SECONDS)
        sending.op.close()
        assertEquals(TransferState.CANCELLED, failure(sending.result).state)
    }
    @Test fun receiverCancelDuringStreamingAbortsPartialFile() {
        val sending = send(source(payload))
        val sink = Sink(root)
        lateinit var op: IncomingTransfer
        op = client().incoming(sending.link.get(10, TimeUnit.SECONDS)) { if (it.bytes > 0) op.close() }
        operations.add(op)
        val result = worker.submit<VerifiedFile> { op.run { sink } }
        assertEquals(TransferState.CANCELLED, failure(result).state)
        assertFalse(sink.target.exists()); assertFalse(sink.stage.exists()); assertTrue(sink.aborted)
        assertNotEquals(TransferState.COMPLETE, failure(sending.result).state)
    }
    @Test fun invitationExpiresWhileWaitingAndCannotBeReceived() {
        val sending = send(source(byteArrayOf(1)), lifetime = 1200)
        val link = sending.link.get(10, TimeUnit.SECONDS)
        assertEquals(TransferState.EXPIRED, failure(sending.result).state)
        val receiving = receive(link, { error("Expired offer must not reach host") })
        assertNotEquals(TransferState.COMPLETE, failure(receiving.second).state)
    }
    @Test fun hostPublicationFailureAbortsWithoutVerifiedSenderCompletion() {
        val sending = send(source(payload))
        val sink = Sink(root, failCommit = true)
        val receiving = receive(sending.link.get(10, TimeUnit.SECONDS), { sink })
        assertNotEquals(TransferState.COMPLETE, failure(receiving.second).state)
        assertNotEquals(TransferState.COMPLETE, failure(sending.result).state)
        assertTrue(sink.aborted); assertFalse(sink.target.exists()); assertFalse(sink.stage.exists())
    }
    @Test fun changedSourceCannotPassDigestVerification() {
        val bytes = payload
        val changed = bytes.clone().also { it[0] = 99 }
        val sending = send(source(bytes) { ByteArrayInputStream(changed) })
        val sink = Sink(root)
        val receiving = receive(sending.link.get(10, TimeUnit.SECONDS), { sink })
        assertNotEquals(TransferState.COMPLETE, failure(sending.result).state)
        assertNotEquals(TransferState.COMPLETE, failure(receiving.second).state)
        assertTrue(sink.aborted); assertFalse(sink.target.exists())
    }
    @Test fun networkLossIsRecoverableFailureAndNewInvitationWorks() {
        val sockets = CopyOnWriteArrayList<Socket>()
        val factory = object : SocketFactory() {
            private fun track(socket: Socket) = socket.also { sockets.add(it) }
            override fun createSocket() = track(Socket())
            override fun createSocket(host: String, port: Int) = track(Socket(host, port))
            override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) = track(Socket(host, port, local, localPort))
            override fun createSocket(host: InetAddress, port: Int) = track(Socket(host, port))
            override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) = track(Socket(host, port, local, localPort))
        }
        val sending = send(source(payload), onUpdate = { if (it.state == TransferState.TRANSFERRING && it.bytes > 0) sockets.forEach { socket -> socket.close() } }, factory = factory)
        val sink = Sink(root)
        val receiving = receive(sending.link.get(10, TimeUnit.SECONDS), { sink })
        assertEquals(TransferState.RECOVERABLE_FAILURE, failure(sending.result).state)
        assertEquals(TransferState.RECOVERABLE_FAILURE, failure(receiving.second).state)
        assertTrue(sink.aborted); assertFalse(sink.target.exists())
        val retry = send(source(byteArrayOf(4, 5, 6)))
        val retrySink = Sink(root)
        val retried = receive(retry.link.get(10, TimeUnit.SECONDS), { retrySink })
        assertEquals(3L, retried.second.get(10, TimeUnit.SECONDS).size)
        assertEquals(3L, retry.result.get(10, TimeUnit.SECONDS).size)
    }
    @Test fun secondReceiverCannotJoinAnOccupiedRoom() {
        val sending = send(source(byteArrayOf(1)))
        val link = sending.link.get(10, TimeUnit.SECONDS)
        val offered = CountDownLatch(1)
        val consent = CountDownLatch(1)
        val first = receive(link, { offered.countDown(); consent.await(10, TimeUnit.SECONDS); Sink(root) })
        assertTrue(offered.await(10, TimeUnit.SECONDS))
        val duplicate = receive(link, { error("Second receiver admitted") })
        assertEquals(TransferState.FAILED, failure(duplicate.second).state)
        consent.countDown()
        assertEquals(1L, first.second.get(10, TimeUnit.SECONDS).size)
        assertEquals(1L, sending.result.get(10, TimeUnit.SECONDS).size)
    }
}
