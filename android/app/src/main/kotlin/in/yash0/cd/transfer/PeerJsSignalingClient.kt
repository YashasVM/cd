package `in`.yash0.cd.transfer

import android.util.Log

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI

/**
 * PeerJS-cloud-compatible signaling client (verified against peerjs@1.5.5).
 *
 * - URL carries `&version=1.5.5` exactly like the browser client.
 * - Sends `HEARTBEAT` every 5s or the server expires the registration.
 * - Speaks full DataConnection envelopes (connectionId / label /
 *   serialization / {type,sdp} objects) so browser peers route our messages.
 */
class PeerJsSignalingClient(
    private val myId: String,
    private val onOpen: () -> Unit,
    private val onOffer: (event: PeerWire.ServerEvent.Offer) -> Unit,
    private val onAnswer: (event: PeerWire.ServerEvent.Answer) -> Unit,
    private val onCandidate: (event: PeerWire.ServerEvent.Candidate) -> Unit,
    private val onIdTaken: () -> Unit,
    private val onPeerGone: (peerId: String) -> Unit,
    private val onError: (message: String) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: WebSocketClient? = null
    private var heartbeatJob: Job? = null
    private var closedByUs = false
    private var gotOpen = false

    fun connect() {
        closedByUs = false
        gotOpen = false
        val uri = URI(
            PeerWire.wsUrl(
                host = TransferProtocol.PEER_HOST,
                port = TransferProtocol.PEER_PORT,
                path = TransferProtocol.PEER_PATH,
                key = TransferProtocol.PEER_KEY,
                id = myId,
                token = myId + "-t",
                secure = TransferProtocol.PEER_SECURE,
            ),
        )
        socket = object : WebSocketClient(uri) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                // Transport ready; registration completes when the server
                // replies OPEN (same as the browser client).
                Log.d(TAG, "ws open, starting heartbeat")
                heartbeatJob?.cancel()
                heartbeatJob = scope.launch {
                    while (isActive) {
                        delay(HEARTBEAT_MS)
                        send(PeerWire.heartbeat())
                    }
                }
            }

            override fun onMessage(message: String) {
                scope.launch { handle(message) }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) {
                Log.d(TAG, "ws close code=$code reason=$reason")
                heartbeatJob?.cancel()
                if (!closedByUs && !gotOpen) onError(reason?.ifBlank { null } ?: "signaling closed")
            }

            override fun onError(ex: Exception) {
                Log.d(TAG, "ws error: ${ex.message}")
                if (!closedByUs) onError(ex.message ?: "signaling failed")
            }
        }
        socket?.connect()
    }

    fun sendOffer(to: String, connectionId: String, sdp: String, label: String) =
        send(PeerWire.offerEnvelope(to, connectionId, sdp, label))

    fun sendAnswer(to: String, connectionId: String, sdp: String) =
        send(PeerWire.answerEnvelope(to, connectionId, sdp))

    fun sendCandidate(to: String, connectionId: String, candidate: String, sdpMid: String?, sdpMLineIndex: Int) =
        send(PeerWire.candidateEnvelope(to, connectionId, candidate, sdpMid, sdpMLineIndex))

    private fun send(text: String) {
        val open = socket?.isOpen == true
        val type = runCatching { Json.parseToJsonElement(text).jsonObject["type"]?.toString() }.getOrNull()
        Log.d(TAG, "sig>> $type open=$open len=${text.length}")
        if (open) runCatching { socket?.send(text) }
    }

    fun close() {
        closedByUs = true
        heartbeatJob?.cancel()
        runCatching { socket?.close() }
        socket = null
        scope.cancel()
    }

    private fun handle(text: String) {
        val ev = PeerWire.parseServerMessage(text)
        if (ev is PeerWire.ServerEvent.Unknown) {
            val keys = runCatching { Json.parseToJsonElement(text).jsonObject.keys.joinToString(",") }.getOrNull()
            Log.d(TAG, "srv<< UNKNOWN keys=[$keys] len=${text.length}")
            return
        }
        Log.d(TAG, "srv<< ${ev::class.simpleName}")
        when (ev) {
            is PeerWire.ServerEvent.Open -> {
                gotOpen = true
                onOpen()
            }
            is PeerWire.ServerEvent.Offer -> onOffer(ev)
            is PeerWire.ServerEvent.Answer -> onAnswer(ev)
            is PeerWire.ServerEvent.Candidate -> onCandidate(ev)
            is PeerWire.ServerEvent.Error -> onError(ev.message)
            is PeerWire.ServerEvent.IdTaken -> onIdTaken()
            is PeerWire.ServerEvent.InvalidKey -> onError("Signaling key rejected.")
            is PeerWire.ServerEvent.PeerGone -> onPeerGone(ev.peerId)
            is PeerWire.ServerEvent.Unknown -> Unit
        }
    }

    companion object {
        const val HEARTBEAT_MS = 5_000L
        private const val TAG = "cd-sig"
    }
}
