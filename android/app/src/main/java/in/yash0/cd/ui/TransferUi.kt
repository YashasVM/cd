package `in`.yash0.cd.ui

import `in`.yash0.cd.Direction
import `in`.yash0.cd.TransferPhase
import `in`.yash0.cd.TransferView
import java.net.URLDecoder
import java.net.URLEncoder

/*
 * Pure presentation logic for the transfer screen and rows. No Compose here so it is JVM unit tested.
 */

/** What the send invitation (QR + private link) area may show. */
sealed interface ShareState {
    /** No invitation to show: receive, finished, expired, or a receiver is already connected. */
    data object Hidden: ShareState
    /** Send started but the relay has not accepted the root yet: no link exists to show. */
    data object Preparing: ShareState
    /** WAITING on the current socket: the only state that may claim readiness. */
    data class Ready(val link: String): ShareState
    /** The invitation is still valid but this phone is not connected to the relay. Keep the QR, don't claim readiness. */
    data class Offline(val link: String, val paused: Boolean, val message: String?): ShareState
}

val ShareState.link: String? get() = when (this) { is ShareState.Ready -> link; is ShareState.Offline -> link; else -> null }

private fun TransferView.expired(now: Long) = expiresAt in 1..now

fun shareState(view: TransferView, now: Long = System.currentTimeMillis()): ShareState {
    if (view.direction != Direction.SEND || view.finished || view.expired(now)) return ShareState.Hidden
    val link = view.link
    return when (view.phase) {
        TransferPhase.WAITING -> if (link != null) ShareState.Ready(link) else ShareState.Preparing
        TransferPhase.PREPARING, TransferPhase.CONNECTING, TransferPhase.RETRYING ->
            if (link != null) ShareState.Offline(link, paused = false, message = view.message) else ShareState.Preparing
        TransferPhase.PAUSED -> if (link != null) ShareState.Offline(link, paused = true, message = view.message) else ShareState.Hidden
        else -> ShareState.Hidden // TRANSFERRING / VERIFYING: the receiver is connected, progress is what matters
    }
}

/** The private link if it may still be shared or copied (not expired, not finished). */
fun liveLink(view: TransferView, now: Long = System.currentTimeMillis()): String? =
    view.link?.takeIf { view.direction == Direction.SEND && !view.finished && !view.expired(now) }

/** Line under a dimmed QR. Never claims the receiver can connect right now. */
fun offlineLabel(share: ShareState.Offline): String =
    if (share.paused) "Not connected — resume to accept the receiver" else "Reconnecting — the link stays the same"

enum class TransferBody { RESULT, SHARE, PREPARING, PROGRESS }

/**
 * Main area of the transfer screen. Before any byte moved, a send keeps the invitation on screen
 * through WAITING / PAUSED / CONNECTING / RETRYING so network flaps never swap the QR for a gauge.
 * Once bytes moved, progress is primary and the link is a compact row.
 */
fun transferBody(view: TransferView, now: Long = System.currentTimeMillis()): TransferBody {
    if (view.finished) return TransferBody.RESULT
    if (view.done != 0L) return TransferBody.PROGRESS
    return when (shareState(view, now)) {
        is ShareState.Ready, is ShareState.Offline -> TransferBody.SHARE
        ShareState.Preparing -> TransferBody.PREPARING
        ShareState.Hidden -> TransferBody.PROGRESS
    }
}

fun transferTitle(view: TransferView, now: Long = System.currentTimeMillis()): String {
    val send = view.direction == Direction.SEND
    return when (view.phase) {
        TransferPhase.COMPLETE -> if (send) "Sent" else "Saved"
        TransferPhase.FAILED -> "Transfer stopped"
        TransferPhase.CANCELLED -> "Cancelled"
        TransferPhase.PAUSED -> "Paused"
        else -> when (if (transferBody(view, now) == TransferBody.SHARE) shareState(view, now) else null) {
            is ShareState.Ready -> "Ready to send"
            is ShareState.Offline -> "Reconnecting"
            else -> if (send) "Sending" else "Receiving"
        }
    }
}

/** Transfer lookup: the same root id can exist once as SEND and once as RECEIVE. */
fun List<TransferView>.findTransfer(id: String, direction: Direction): TransferView? = firstOrNull { it.id == id && it.direction == direction }

/**
 * Bundle codec for the navigation state, so the current tab and screen stack survive configuration
 * changes and process recreation. Plain text, so it is unit tested without Android. Transfer ids are
 * not secrets (the relay sees them); private links are never stored here.
 */
object NavCodec {
    data class Nav(val tab: Tab, val stack: List<Screen>)

    val Default = Nav(Tab.SEND, listOf(Screen.Home))
    private const val VERSION = "nav1"
    private const val MAX_DEPTH = 16
    private val transferId = Regex("[A-Za-z0-9_-]{1,128}")

    fun encode(tab: Tab, stack: List<Screen>): String {
        if (stack.any { it is Screen.Transfer && !transferId.matches(it.id) }) return encode(Default.tab, Default.stack)
        return (listOf(VERSION, tab.name) + stack.map(::token)).joinToString("\n")
    }

    /** Any unknown or malformed value restores home on the Send tab rather than a half-valid stack. */
    fun decode(raw: String?): Nav {
        val parts = raw?.split("\n") ?: return Default
        if (parts.size < 3 || parts[0] != VERSION || parts.size - 2 > MAX_DEPTH) return Default
        val tab = Tab.entries.firstOrNull { it.name == parts[1] } ?: return Default
        val stack = parts.drop(2).map { screen(it) ?: return Default }
        if (stack.first() != Screen.Home || stack.drop(1).any { it == Screen.Home }) return Default
        return Nav(tab, stack)
    }

    private fun token(screen: Screen): String = when (screen) {
        Screen.Home -> "home"
        Screen.Settings -> "settings"
        is Screen.Transfer -> "transfer:${screen.direction.name}:${URLEncoder.encode(screen.id, "UTF-8")}"
    }

    private fun screen(token: String): Screen? = when {
        token == "home" -> Screen.Home
        token == "settings" -> Screen.Settings
        token.startsWith("transfer:") -> {
            val rest = token.removePrefix("transfer:").split(":", limit = 2)
            val direction = Direction.entries.firstOrNull { it.name == rest.getOrNull(0) }
            val id = rest.getOrNull(1)?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            if (direction == null || id == null || !transferId.matches(id)) null else Screen.Transfer(id, direction)
        }
        else -> null
    }
}
    if (codeExpired(view, now)) return if (view.code != null) "Code expired" else "No live code"
    if (send && !view.isPrivate && view.codeSpent && view.phase == TransferPhase.WAITING) return "Waiting for receiver"
    if (codeExpired(view, now)) return TransferBody.CODE_EXPIRED
