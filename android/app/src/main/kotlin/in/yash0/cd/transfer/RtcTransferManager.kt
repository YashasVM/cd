package `in`.yash0.cd.transfer

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer

/**
 * WebRTC data-channel transport speaking PeerJS `binary` serialization:
 * every frame is msgpack-packed (control maps AND file bytes alike),
 * with PeerJS `{__peerData,n,data,total}` chunking above 16300 bytes.
 * See [PeerWire]; verified against peerjs@1.5.5's BinarySerializer.
 */
class RtcTransferManager(
    context: Context,
    private val onFrame: (PeerFrame) -> Unit,
    private val onConnected: () -> Unit,
    private val onDisconnected: () -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val appContext = context.applicationContext
    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var channel: DataChannel? = null
    private var egl: EglBase? = null
    private val reassembler = PeerWire.Reassembler()

    val isConnected: Boolean get() = channel?.state() == DataChannel.State.OPEN

    private fun ensureFactory() {
        if (factory != null) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions(),
        )
        egl = EglBase.create()
        val options = PeerConnectionFactory.Options()
        factory = PeerConnectionFactory.builder()
            .setOptions(options)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl?.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl?.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun rtcConfig(): PeerConnection.RTCConfiguration {
        val ice = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:global.stun.twilio.com:3478").createIceServer(),
            // TURN relay: required behind symmetric NATs / emulator SLIRP where
            // inbound srflx checks never arrive. Production builds should point
            // this at the project's own coturn/Cloudflare TURN endpoint.
            PeerConnection.IceServer.builder(TransferProtocol.turnUrl())
                .setUsername(TransferProtocol.TURN_USER)
                .setPassword(TransferProtocol.TURN_PASS)
                .createIceServer(),
        )
        return PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
    }

    private val peerObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            Log.d(TAG, "ice gathered: ${candidate.sdpMid}:${candidate.sdpMLineIndex} ${candidate.sdp.take(60)}")
            pendingIce?.invoke(candidate)
        }
        override fun onDataChannel(dc: DataChannel) = attachChannel(dc)
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) {}
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.d(TAG, "pc state=$newState")
            if (newState == PeerConnection.PeerConnectionState.CONNECTED) onConnected()
            if (newState == PeerConnection.PeerConnectionState.FAILED ||
                newState == PeerConnection.PeerConnectionState.CLOSED
            ) onDisconnected()
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            Log.d(TAG, "ice state=$state")
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.DISCONNECTED ||
                state == PeerConnection.IceConnectionState.CLOSED
            ) onDisconnected()
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<MediaStream>) {}
    }

    private var pendingIce: ((IceCandidate) -> Unit)? = null

    fun setIceEmitter(emit: (IceCandidate) -> Unit) {
        pendingIce = emit
    }

    private fun attachChannel(dc: DataChannel) {
        channel = dc
        Log.d(TAG, "attachChannel label=${dc.label()} state=${dc.state()}")
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onStateChange() {
                Log.d(TAG, "dc state=${dc.state()} buffered=${dc.bufferedAmount()}")
                if (dc.state() == DataChannel.State.OPEN) onConnected()
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                // PeerJS always delivers arraybuffer (binary) frames.
                if (!buffer.binary) return
                val frame = runCatching { reassembler.feed(bytes) }.getOrNull() ?: return
                onFrame(frame)
            }
        })
    }

    /**
     * Initiator side (mirrors peerjs createDataChannel(label, {ordered}) +
     * offer). Label is the connectionId, exactly like the browser client.
     */
    fun createOffer(
        label: String,
        onSdp: (type: SessionDescription.Type, sdp: String) -> Unit,
        onFailure: (String) -> Unit,
    ) {
        scope.launch {
            try {
                ensureFactory()
                peer = factory?.createPeerConnection(rtcConfig(), peerObserver)
                // Web uses reliable:true -> {ordered:true}.
                val init = DataChannel.Init().apply { ordered = true }
                attachChannel(peer?.createDataChannel(label, init) ?: return@launch)
                peer?.createOffer(object : SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription) {
                        Log.d(TAG, "offer sdp:\n${desc.description}")
                        peer?.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() = onSdp(desc.type, desc.description)
                            override fun onSetFailure(msg: String?) = onFailure(msg ?: "setLocal failed")
                            override fun onCreateSuccess(p0: SessionDescription?) {}
                            override fun onCreateFailure(msg: String?) = onFailure(msg ?: "offer failed")
                        }, desc)
                    }
                    override fun onCreateFailure(msg: String?) = onFailure(msg ?: "offer failed")
                    override fun onSetSuccess() {}
                    override fun onSetFailure(msg: String?) = onFailure(msg ?: "offer failed")
                }, MediaConstraints())
            } catch (t: Throwable) {
                onFailure(t.message ?: "webrtc failed")
            }
        }
    }

    /** Responder side: accept the initiator's offer, produce an answer. */
    fun createAnswer(
        remoteSdp: String,
        onSdp: (type: SessionDescription.Type, sdp: String) -> Unit,
        onFailure: (String) -> Unit,
    ) {
        scope.launch {
            try {
                ensureFactory()
                peer = factory?.createPeerConnection(rtcConfig(), peerObserver)
                peer?.setRemoteDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        peer?.createAnswer(object : SdpObserver {
                            override fun onCreateSuccess(desc: SessionDescription) {
                                peer?.setLocalDescription(object : SdpObserver {
                                    override fun onSetSuccess() = onSdp(desc.type, desc.description)
                                    override fun onSetFailure(msg: String?) = onFailure(msg ?: "setLocal failed")
                                    override fun onCreateSuccess(p0: SessionDescription?) {}
                                    override fun onCreateFailure(msg: String?) = onFailure(msg ?: "answer failed")
                                }, desc)
                            }
                            override fun onCreateFailure(msg: String?) = onFailure(msg ?: "answer failed")
                            override fun onSetSuccess() {}
                            override fun onSetFailure(msg: String?) = onFailure(msg ?: "answer failed")
                        }, MediaConstraints())
                    }
                    override fun onSetFailure(msg: String?) = onFailure(msg ?: "setRemote failed")
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(msg: String?) = onFailure(msg ?: "answer failed")
                }, SessionDescription(SessionDescription.Type.OFFER, remoteSdp))
            } catch (t: Throwable) {
                onFailure(t.message ?: "webrtc failed")
            }
        }
    }

    fun acceptAnswer(sdp: String) {
        Log.d(TAG, "acceptAnswer len=${sdp.length}")
        peer?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {}
            override fun onSetFailure(msg: String?) {}
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(msg: String?) {}
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    fun addRemoteCandidate(candidate: String, sdpMid: String?, index: Int) {
        Log.d(TAG, "addRemoteCandidate $sdpMid:$index")
        peer?.addIceCandidate(IceCandidate(sdpMid, index, candidate))
    }

    /** Sends already-framed (msgpack) bytes as one binary data-channel message. */
    private fun sendFrame(frame: ByteArray): Boolean {
        val dc = channel ?: return false
        if (dc.state() != DataChannel.State.OPEN) return false
        if (dc.bufferedAmount() > TransferProtocol.MAX_BUFFERED_AMOUNT) return false
        return dc.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))
    }

    fun sendControl(fields: Map<String, Any?>): Boolean {
        val frames = PeerWire.packControl(fields)
        var ok = true
        frames.forEach { ok = sendFrame(it) && ok }
        return ok
    }

    fun sendFileBytes(bytes: ByteArray, offset: Int = 0, len: Int = bytes.size): Boolean {
        val frames = PeerWire.packBytes(bytes, offset, len)
        var ok = true
        frames.forEach { ok = sendFrame(it) && ok }
        return ok
    }

    fun bufferedAmount(): Long = channel?.bufferedAmount() ?: 0L

    companion object {
        private const val TAG = "cd-rtc"
    }

    fun close() {
        runCatching { channel?.close() }
        runCatching { peer?.close() }
        channel = null
        peer = null
    }
}
