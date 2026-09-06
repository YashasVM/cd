package dev.yvm.cd

import android.os.Bundle
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
private enum class AppDestination(val label: String, val marker: String) {
  CONNECTED_PCS("Connected PCs", "01"),
  SEND_FILES("Send Files", "02"),
  CLIPBOARD("Clipboard", "03"),
  RECENT_TRANSFERS("Recent Transfers", "04"),
}

class MainActivity : ComponentActivity() {
  private var sharedUris by mutableStateOf<List<Uri>>(emptyList())

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    sharedUris = extractSharedUris(intent)
    setContent { CdTheme { CdApp(sharedUris) } }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    sharedUris = extractSharedUris(intent)
  }
}

private fun extractSharedUris(intent: Intent?): List<Uri> {
  if (intent == null || intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return emptyList()
  val uris = buildList {
    intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(::add)
    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let(::addAll)
    intent.clipData?.let { clipData ->
      for (index in 0 until clipData.itemCount) {
        clipData.getItemAt(index).uri?.let(::add)
      }
    }
  }
  return uris.filter { it.scheme == "content" || it.scheme == "file" }.distinct()
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
private fun CdApp(sharedUris: List<Uri>) {
  var destination by rememberSaveable { mutableStateOf(AppDestination.SEND_FILES) }
  Scaffold(
    containerColor = CdBackground,
    bottomBar = {
      NavigationBar(containerColor = CdBackground) {
        AppDestination.entries.forEach { item ->
          NavigationBarItem(
            selected = item == destination,
            onClick = { destination = item },
            icon = { Text(item.marker, fontFamily = FontFamily.Monospace, fontSize = 10.sp) },
            label = { Text(item.label, fontSize = 10.sp) },
            modifier = Modifier.height(64.dp),
          )
        }
      }
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding)) {
      when (destination) {
        AppDestination.SEND_FILES -> SendFilesScreen(sharedUris)
        AppDestination.CONNECTED_PCS -> EmptyDestinationScreen(
          title = "Connected PCs",
          message = "No trusted PCs yet. Pairing is not available in this build.",
        )
        AppDestination.CLIPBOARD -> EmptyDestinationScreen(
          title = "Clipboard",
          message = "Clipboard sync is not available in this build.",
        )
        AppDestination.RECENT_TRANSFERS -> EmptyDestinationScreen(
          title = "Recent Transfers",
          message = "Transfer history will appear here after it is supported.",
        )
      }
    }
  }
}

@Composable
private fun SendFilesScreen(sharedUris: List<Uri>) {
  var mode by rememberSaveable { mutableStateOf(TransferMode.CLOUD) }
  Column(Modifier.fillMaxSize()) {
    ModeBar(mode, onModeChange = { mode = it })
    Box(Modifier.fillMaxSize()) {
      if (mode == TransferMode.CLOUD) {
        CloudTransferScreen(visible = true, modifier = Modifier.fillMaxSize())
      } else {
        LocalTransferRoute(initialUris = sharedUris)
      }
    }
  }
}

@Composable
private fun EmptyDestinationScreen(title: String, message: String) {
  Column(
    modifier = Modifier.fillMaxSize().padding(22.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text(title, fontSize = 28.sp)
    Card(
      colors = CardDefaults.cardColors(containerColor = CdRaised),
      shape = RoundedCornerShape(8.dp),
    ) {
      Text(
        message,
        modifier = Modifier.padding(20.dp),
        color = CdTextSecondary,
        fontSize = 15.sp,
        lineHeight = 23.sp,
      )
    }
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
          androidx.compose.material3.ButtonDefaults.textButtonColors(
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
