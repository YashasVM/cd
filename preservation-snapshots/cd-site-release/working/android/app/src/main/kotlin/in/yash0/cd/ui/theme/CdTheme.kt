package `in`.yash0.cd.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val CdScheme = darkColorScheme(
    background = CdColors.Bg,
    surface = CdColors.Surface,
    surfaceVariant = CdColors.Surface2,
    primary = CdColors.Accent,
    onPrimary = CdColors.Bg,
    secondary = CdColors.Muted,
    onBackground = CdColors.Text,
    onSurface = CdColors.Text,
    outline = CdColors.Line,
    error = CdColors.Error,
    onError = CdColors.Text,
)

object CdType {
    val Display = TextStyle(fontFamily = FontFamily.Serif, fontWeight = FontWeight.Normal, fontSize = 34.sp, letterSpacing = (-0.5).sp)
    val Tagline = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = CdColors.Faint)
    val Kicker = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 10.sp, letterSpacing = 1.2.sp, color = CdColors.Faint)
    val Code = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 36.sp, letterSpacing = 2.sp, color = CdColors.Accent)
    val Body = TextStyle(fontSize = 14.sp, color = CdColors.Text)
    val SmallMono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = CdColors.Muted)
}

@Composable
fun CdTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = CdScheme, content = content)
}
