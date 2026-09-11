package `in`.yash0.cd.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.ui.theme.CdColors
import `in`.yash0.cd.ui.theme.CdType

@Composable
fun CdCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = CdColors.Surface),
        border = BorderStroke(1.dp, CdColors.Line),
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

@Composable
fun Kicker(text: String) {
    Text(text.uppercase(), style = CdType.Kicker)
}

@Composable
fun PrimaryBtn(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            containerColor = CdColors.PrimaryBtn,
            contentColor = CdColors.Accent,
            disabledContainerColor = CdColors.Surface2,
            disabledContentColor = CdColors.Faint,
        ),
    ) { Text(text) }
}

@Composable
fun SecondaryBtn(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        border = BorderStroke(1.dp, CdColors.Line),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = CdColors.Muted),
    ) { Text(text) }
}

@Composable
fun CdProgress(percent01: Float, modifier: Modifier = Modifier) {
    LinearProgressIndicator(
        progress = { percent01.coerceIn(0f, 1f) },
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(999.dp)),
        color = CdColors.Accent,
        trackColor = Color(0xFF080302),
        strokeCap = StrokeCap.Round,
    )
}

/** Gradient variant echoing the web sheen fill. */
@Composable
fun CdProgressGradient(percent01: Float, modifier: Modifier = Modifier) {
    // LinearProgressIndicator takes a single color; emulate the ember
    // gradient with a brushed overlay track behind it.
    androidx.compose.foundation.layout.Box(modifier) {
        androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxWidth()) {
            drawRect(
                brush = Brush.horizontalGradient(
                    0f to CdColors.AccentSoft,
                    1f to CdColors.Accent,
                ),
                alpha = 0.25f,
                size = size,
            )
        }
        CdProgress(percent01 = percent01)
    }
}
