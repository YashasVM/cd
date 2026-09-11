package `in`.yash0.cd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.NorthEast
import androidx.compose.material.icons.filled.SouthWest
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import `in`.yash0.cd.data.FunCodes
import `in`.yash0.cd.data.TransferState
import `in`.yash0.cd.service.TransferService
import `in`.yash0.cd.transfer.TransferViewModel
import `in`.yash0.cd.ui.components.BrandHeader
import `in`.yash0.cd.ui.components.DottedBackground
import `in`.yash0.cd.ui.screens.HistoryScreen
import `in`.yash0.cd.ui.screens.ReceiveScreen
import `in`.yash0.cd.ui.screens.ScannerScreen
import `in`.yash0.cd.ui.screens.SendScreen
import `in`.yash0.cd.ui.theme.CdColors
import `in`.yash0.cd.ui.theme.CdTheme

class MainActivity : ComponentActivity() {
    private val vm: TransferViewModel by viewModels()
    private var pendingCode by mutableStateOf("")
    private var pendingTab by mutableStateOf<String?>(null)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        handleIntent(intent)
        setContent { CdRoot() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_VIEW -> {
                val raw = intent.dataString ?: return
                val code = FunCodes.fromLinkOrCode(raw)
                if (FunCodes.isValid(code)) {
                    pendingCode = code
                    pendingTab = "receive"
                }
            }
            Intent.ACTION_SEND -> {
                val uri = readSingleStream(intent) ?: return
                // Sharing files INTO cd means "send these": reset any stale
                // session and start hosting immediately.
                vm.reset()
                vm.setPicked(listOf(uri))
                vm.host()
                pendingTab = "send"
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = readMultipleStreams(intent)
                if (uris.isNotEmpty()) {
                    vm.reset()
                    vm.setPicked(uris)
                    vm.host()
                }
                pendingTab = "send"
            }
        }
    }

    private fun readSingleStream(intent: Intent): Uri? = runCatching {
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }.getOrNull()

    private fun readMultipleStreams(intent: Intent): List<Uri> = runCatching {
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
    }.getOrDefault(emptyList())

    @Composable
    private fun CdRoot() {
        CdTheme {
            DottedBackground(Modifier.fillMaxSize()) {
                val nav = rememberNavController()
                val backstack by nav.currentBackStackEntryAsState()
                val route = backstack?.destination?.route ?: "send"
                val state by vm.state.collectAsState()
                val code by vm.code.collectAsState()

                LaunchedEffect(pendingTab) {
                    pendingTab?.let {
                        nav.navigate(it) { launchSingleTop = true }
                        pendingTab = null
                    }
                }
                // Deep-link / scanner codes join exactly once, outside composition.
                LaunchedEffect(pendingCode) {
                    val c = pendingCode
                    if (c.isNotBlank()) {
                        pendingCode = ""
                        if (FunCodes.isValid(c)) vm.join(c)
                    }
                }
                LaunchedEffect(state) {
                    when (state) {
                        TransferState.WAITING -> TransferService.start(this@MainActivity, "Waiting for receiver... ${code.ifBlank { "" }}")
                        TransferState.CONNECTING -> TransferService.start(this@MainActivity, "Finding the sender...")
                        TransferState.TRANSFERRING, TransferState.SAVING ->
                            TransferService.start(this@MainActivity, "Transfer running")
                        else -> TransferService.stop(this@MainActivity)
                    }
                }

                Scaffold(
                    containerColor = CdColors.Bg,
                    bottomBar = {
                        if (route != "scanner") {
                            NavigationBar(containerColor = CdColors.Bg) {
                                BarItem(route == "send", "Send", Icons.Filled.NorthEast) { nav.navigate("send") { launchSingleTop = true } }
                                BarItem(route == "receive", "Receive", Icons.Filled.SouthWest) { nav.navigate("receive") { launchSingleTop = true } }
                                BarItem(route == "history", "History", Icons.Filled.History) { nav.navigate("history") { launchSingleTop = true } }
                            }
                        }
                    },
                ) { inner ->
                    Column(
                        Modifier.padding(inner).padding(horizontal = 20.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        BrandHeader(state = state.label, modifier = Modifier.padding(top = 28.dp, bottom = 18.dp))
                        NavHost(nav, startDestination = "send", modifier = Modifier.padding(bottom = 24.dp)) {
                            composable("send") { SendScreen(vm) }
                            composable("receive") {
                                ReceiveScreen(vm, onScan = { nav.navigate("scanner") })
                            }
                            composable("history") { HistoryScreen(vm) }
                            composable("scanner") {
                                ScannerScreen(
                                    onCode = {
                                        pendingCode = it
                                        nav.popBackStack()
                                        nav.navigate("receive") { launchSingleTop = true }
                                    },
                                    onClose = { nav.popBackStack() },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun RowScope.BarItem(selected: Boolean, label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
        NavigationBarItem(
            selected = selected,
            onClick = onClick,
            icon = { Icon(icon, contentDescription = label) },
            label = { Text(label) },
            colors = NavigationBarItemDefaults.colors(
                selectedIconColor = CdColors.Accent,
                selectedTextColor = CdColors.Text,
                unselectedIconColor = CdColors.Faint,
                unselectedTextColor = CdColors.Faint,
                indicatorColor = CdColors.Surface2,
            ),
        )
    }
}
