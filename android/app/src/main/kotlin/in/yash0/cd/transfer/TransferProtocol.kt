package `in`.yash0.cd.transfer

/** Mirrors web runtime defaults in src/main.js. */
object TransferProtocol {
    const val PEER_PREFIX = "cd-"
    const val CHUNK_SIZE = 16 * 1024 - 128
    const val MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024
    const val BUFFER_LOW_AMOUNT = 2 * 1024 * 1024
    const val CONNECTION_TIMEOUT_MS = 15_000L
    const val PEER_HOST = "0.peerjs.com"
    const val PEER_PORT = 443
    const val PEER_PATH = "/"
    const val PEER_KEY = "peerjs"
    const val PEER_SECURE = true

    fun receiveLink(code: String): String = "https://cd.yash0.in/?receive=${code.lowercase()}"

    // TURN relay for NATs that block inbound peer checks (symmetric NATs,
    // emulator SLIRP, some corporate VPNs). Overridable per build; the web
    // client brings only STUN, so one-sided TURN here still unblocks both
    // directions because all media can hairpin through this relay.
    const val TURN_HOST = "10.0.2.2"
    const val TURN_PORT = 3478
    const val TURN_USER = "cd"
    const val TURN_PASS = "cdturn123"

    fun turnUrl(): String = "turn:$TURN_HOST:$TURN_PORT"
}
