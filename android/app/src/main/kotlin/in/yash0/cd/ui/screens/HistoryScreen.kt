package `in`.yash0.cd.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import `in`.yash0.cd.transfer.TransferViewModel
import `in`.yash0.cd.ui.components.CdCard
import `in`.yash0.cd.ui.components.Kicker
import `in`.yash0.cd.ui.components.SecondaryBtn
import `in`.yash0.cd.ui.theme.CdColors
import `in`.yash0.cd.ui.theme.CdType
import java.text.DateFormat
import java.util.Date

@Composable
fun HistoryScreen(vm: TransferViewModel) {
    val entries by vm.history.collectAsState(initial = emptyList())
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        CdCard {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Kicker("transfer history")
                if (entries.isNotEmpty()) SecondaryBtn("Clear", onClick = { vm.clearHistory() })
            }
            if (entries.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("Nothing yet. Sent and received files land here.", style = CdType.SmallMono)
            }
        }
        entries.forEach { e ->
            CdCard {
                Kicker(e.direction)
                Text(e.title, style = CdType.Body)
                Spacer(Modifier.height(4.dp))
                Text(
                    "${e.detail} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(e.atMs))}",
                    style = CdType.SmallMono.copy(color = CdColors.Faint),
                )
            }
        }
    }
}
