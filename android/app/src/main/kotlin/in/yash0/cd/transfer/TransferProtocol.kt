package `in`.yash0.cd.transfer

import `in`.yash0.cd.data.FunCodes

/** Mirrors web runtime defaults in src/main.js. */
object TransferProtocol {
    const val PEER_PREFIX = "cd-"
    const val CHUNK_SIZE = 16 * 1024 - 128
    const val MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024
    const val BUFFER_LOW_AMOUNT = 2 * 1024 * 1024
    const val CONNECTION_TIMEOUT_MS = 15_000L
    const val PEER_HOST = "cd.yash0.in"
    const val PEER_PORT = 443
    const val PEER_PATH = "/peerjs/"
    const val PEER_KEY = "peerjs"
    const val PEER_SECURE = true

    fun receiveLink(code: String): String = "https://cd.yash0.in/#p2p.${FunCodes.normalize(code)}"
}
