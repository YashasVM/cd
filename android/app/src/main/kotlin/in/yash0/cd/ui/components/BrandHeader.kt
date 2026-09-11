package `in`.yash0.cd.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.ui.theme.CdColors
import `in`.yash0.cd.ui.theme.CdType

/**
 * Pro reinterpretation of the web brand-rail: serif "cd",
 * mono "/di·rect/", "no cloud detour" pill, and "state / xxx" line.
 */
@Composable
fun BrandHeader(state: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("cd", style = CdType.Display, color = CdColors.Text)
            Spacer(Modifier.width(10.dp))
            Text("/di·rect/", style = CdType.Tagline)
        }
        Text(
            "no cloud detour",
            style = CdType.Tagline,
            modifier = Modifier
                .padding(top = 6.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(CdColors.Surface2)
                .padding(horizontal = 10.dp, vertical = 5.dp),
        )
        Text(
            "Direct browser-to-browser file transfer",
            style = CdType.Body,
            color = CdColors.Text,
            modifier = Modifier.padding(top = 12.dp),
        )
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("STATE /", style = CdType.Tagline)
            Spacer(Modifier.width(6.dp))
            Text(state.lowercase(), style = CdType.Tagline.copy(color = CdColors.Accent))
        }
    }
}
