package dev.yvm.cd

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextButtonDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val CdBackground = Color(0xFF0A0A0A)
internal val CdRaised = Color(0xFF191919)
internal val CdSurface = Color(0xFF1A1C20)
internal val CdBorder = Color(0xFF212327)
internal val CdText = Color.White
internal val CdTextSecondary = Color(0xFFDADBDF)
internal val CdMuted = Color(0xFF7D8187)

internal enum class TransferMode { LOCAL, CLOUD }

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { CdTheme { CdApp() } }
  }
}

@Composable
private fun CdTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme =
      darkColorScheme(
        primary = CdText,
        onPrimary = CdBackground,
        background = CdBackground,
        onBackground = CdText,
        surface = CdRaised,
        onSurface = CdText,
        outline = CdBorder,
        error = Color(0xFFE5484D),
      ),
    content = content,
  )
}

@Composable
private fun CdApp() {
  var mode by rememberSaveable { mutableStateOf(TransferMode.CLOUD) }
  Scaffold(
    containerColor = CdBackground,
    bottomBar = { ModeBar(mode, onModeChange = { mode = it }) },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding)) {
      if (mode == TransferMode.LOCAL) Placeholder("Local transfer", "Nearby device discovery is being connected.")
      else Placeholder("Cloud transfer", "Clerk sign-in and internet sharing are being connected.")
    }
  }
}

@Composable
private fun Placeholder(title: String, message: String) {
  Column(
    modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 28.dp),
    verticalArrangement = Arrangement.Center,
  ) {
    Text("CD", fontSize = 28.sp, fontWeight = FontWeight.Normal, letterSpacing = (-1).sp)
    Spacer(Modifier.height(48.dp))
    Text(title, fontSize = 30.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.5).sp)
    Spacer(Modifier.height(12.dp))
    Text(message, color = CdMuted, fontSize = 15.sp, lineHeight = 23.sp)
  }
}

@Composable
private fun ModeBar(mode: TransferMode, onModeChange: (TransferMode) -> Unit) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(CdBackground)
        .border(width = 1.dp, color = CdBorder)
        .padding(horizontal = 16.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
  ) {
    TransferMode.entries.forEach { item ->
      val selected = item == mode
      TextButton(
        onClick = { onModeChange(item) },
        modifier = Modifier.widthIn(min = 112.dp).height(48.dp),
        shape = RoundedCornerShape(999.dp),
        colors =
          TextButtonDefaults.textButtonColors(
            containerColor = if (selected) CdText else Color.Transparent,
            contentColor = if (selected) CdBackground else CdMuted,
          ),
      ) {
        Text(
          text = item.name.lowercase().replaceFirstChar(Char::uppercase),
          fontFamily = FontFamily.Monospace,
          fontSize = 12.sp,
          letterSpacing = 1.sp,
        )
      }
    }
  }
}
