package `in`.yash0.cd.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import `in`.yash0.cd.data.FunCodes
import `in`.yash0.cd.ui.components.CdCard
import `in`.yash0.cd.ui.components.Kicker
import `in`.yash0.cd.ui.components.SecondaryBtn
import `in`.yash0.cd.ui.theme.CdType
import java.util.concurrent.Executors

/** Native replacement for html5-qrcode: CameraX + ML Kit, instant + torch-friendly. */
@androidx.annotation.OptIn(ExperimentalGetImage::class)
@Composable
fun ScannerScreen(onCode: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var fired by remember { mutableStateOf(false) }
    val requester = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) requester.launch(Manifest.permission.CAMERA) }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        CdCard {
            Kicker("scan the sender qr")
            Text("Point it at the code.", style = CdType.SmallMono)
        }
        if (granted) {
            AndroidView(
                factory = { c ->
                    PreviewView(c).also { pv ->
                        val providerFuture = ProcessCameraProvider.getInstance(c)
                        providerFuture.addListener({
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build().apply {
                                setSurfaceProvider(pv.surfaceProvider)
                            }
                            val scanner = BarcodeScanning.getClient()
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            val executor = Executors.newSingleThreadExecutor()
                            analysis.setAnalyzer(executor) { proxy ->
                                val media = proxy.image
                                if (media != null && !fired) {
                                    val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                                    scanner.process(image)
                                        .addOnSuccessListener { codes ->
                                            val raw = codes.firstOrNull()?.rawValue ?: return@addOnSuccessListener
                                            val code = FunCodes.fromLinkOrCode(raw)
                                            if (FunCodes.isValid(code) && !fired) {
                                                fired = true
                                                onCode(code)
                                            }
                                        }
                                        .addOnCompleteListener { proxy.close() }
                                } else {
                                    proxy.close()
                                }
                            }
                            runCatching {
                                provider.unbindAll()
                                provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                            }
                        }, ContextCompat.getMainExecutor(c))
                    }
                },
                modifier = Modifier.fillMaxWidth().height(360.dp),
            )
            DisposableEffect(Unit) {
                onDispose {
                    runCatching { ProcessCameraProvider.getInstance(ctx).get().unbindAll() }
                }
            }
        } else {
            CdCard {
                Text("Camera said no. Type the code instead.", style = CdType.Body)
            }
        }
        SecondaryBtn("Back", onClick = onClose, modifier = Modifier.fillMaxWidth())
    }
}
