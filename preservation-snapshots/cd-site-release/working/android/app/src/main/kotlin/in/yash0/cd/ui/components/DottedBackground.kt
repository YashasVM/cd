package `in`.yash0.cd.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import `in`.yash0.cd.ui.theme.CdColors

/**
 * Inspired by web body::before: ember dot-grain over a top glow,
 * fading out toward mid-screen. Drawn natively, subtly, once.
 */
@Composable
fun DottedBackground(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier = modifier) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val h = size.height
            drawRect(
                brush = Brush.verticalGradient(
                    0f to CdColors.BgGlowTop,
                    0.45f to CdColors.Bg,
                    1f to CdColors.Bg,
                ),
                size = size,
            )
            // Three dot lattices like the web 5px/7px/9px grains.
            val grains = listOf(
                Triple(5f, Color(0x6BE53E0F), 0f),
                Triple(7f, Color(0x8F7A1A08), 2.3f),
                Triple(9f, Color(0x52CD310B), 4.1f),
            )
            grains.forEach { (stepDp, color, phase) ->
                val step = stepDp * density * 3f
                var y = phase * density
                var row = 0
                while (y < h * 0.6f) {
                    var x = ((row % 2) * step / 2f + phase * density) % step
                    while (x < size.width) {
                        val fade = 1f - (y / (h * 0.6f))
                        drawCircle(color.copy(alpha = color.alpha * fade), radius = 1f * density, center = Offset(x, y))
                        x += step
                    }
                    y += step
                    row++
                }
            }
        }
        content()
    }
}
