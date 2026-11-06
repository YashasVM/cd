package `in`.yash0.cd.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Professional reinterpretation of the cd web palette (src/style.css).
 * Not a copy: same ember-on-espresso mood + dotted grain, but with
 * proper contrast steps, solid surfaces, and named roles for Compose.
 */
object CdColors {
    val Bg = Color(0xFF0D0503)
    val BgGlowTop = Color(0xFF160302)
    val Surface = Color(0xFF160907)      // cards: .file-info etc.
    val Surface2 = Color(0xFF1B0D09)     // inner blocks, stats
    val Ink = Color(0xFF070707)          // QR block, inputs
    val PrimaryBtn = Color(0xFF24110C)
    val PrimaryBtnHover = Color(0xFF32170F)

    val Text = Color(0xFFE4D4B6)
    val Muted = Color(0xFFA8987E)
    val Faint = Color(0xFF6E6350)
    val Line = Color(0xFF2A1D16)

    val Accent = Color(0xFFE58A57)
    val AccentSoft = Color(0xFF6B2F1C)
    val AccentGlow = Color(0xFFE53E0F)

    val Error = Color(0xFFFF5D2A)
    val ErrorBg = Color(0xFF5A160B)
    val ErrorText = Color(0xFFFF8A62)
    val Ok = Color(0xFFE58A57)
}
