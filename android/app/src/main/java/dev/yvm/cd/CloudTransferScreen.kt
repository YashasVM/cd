package dev.yvm.cd

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

internal const val CD_WEB_URL = "https://cd.yvm.workers.dev/"
internal const val CD_WEB_ORIGIN = "https://cd.yvm.workers.dev"
private const val CD_WEB_HOST = "cd.yvm.workers.dev"

@Composable
internal fun CloudTransferScreen(visible: Boolean, modifier: Modifier = Modifier) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val activity = context as Activity
  val lifecycleOwner = LocalLifecycleOwner.current
  var webView by remember { mutableStateOf<WebView?>(null) }
  var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
  var progress by remember { mutableIntStateOf(0) }
  var loadError by remember { mutableStateOf(false) }
  var canGoBack by remember { mutableStateOf(false) }
  val picker =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
      fileCallback = null
    }

  BackHandler(enabled = visible && canGoBack) { webView?.goBack() }

  Box(modifier.background(CdBackground)) {
    AndroidView(
      factory = {
        createCdWebView(
          activity = activity,
          onFileRequest = { callback, parameters ->
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            try {
              picker.launch(fileIntent(parameters))
              true
            } catch (_: ActivityNotFoundException) {
              fileCallback = null
              callback.onReceiveValue(null)
              Toast.makeText(activity, "No file picker is available.", Toast.LENGTH_SHORT).show()
              false
            }
          },
          onProgress = { progress = it },
          onError = { loadError = true },
          onLoaded = {
            loadError = false
            canGoBack = it.canGoBack()
          },
        ).also { webView = it }
      },
      update = { it.visibility = if (visible) View.VISIBLE else View.INVISIBLE },
      modifier = Modifier.fillMaxSize(),
    )

    if (visible && progress in 0..99 && !loadError) {
      LinearProgressIndicator(
        modifier = Modifier.align(Alignment.TopCenter).fillMaxWidth().height(2.dp),
        color = CdText,
        trackColor = CdBackground,
      )
    }

    if (visible && loadError) {
      CloudError {
        loadError = false
        progress = 0
        webView?.reload()
      }
    }
  }

  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        when (event) {
          Lifecycle.Event.ON_RESUME -> webView?.onResume()
          Lifecycle.Event.ON_PAUSE -> webView?.onPause()
          else -> Unit
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      fileCallback?.onReceiveValue(null)
      fileCallback = null
      webView?.stopLoading()
      webView?.destroy()
      webView = null
    }
  }
}

@Suppress("SetJavaScriptEnabled")
private fun createCdWebView(
  activity: Activity,
  onFileRequest: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean,
  onProgress: (Int) -> Unit,
  onError: () -> Unit,
  onLoaded: (WebView) -> Unit,
) =
  WebView(activity).apply {
    if ((activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
    setBackgroundColor(AndroidColor.rgb(10, 10, 10))
    keepScreenOn = true
    settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      safeBrowsingEnabled = true
      mediaPlaybackRequiresUserGesture = true
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
      userAgentString = "$userAgentString CD-Android/1.0"
    }
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    cookies.setAcceptThirdPartyCookies(this, true)
    webChromeClient =
      object : WebChromeClient() {
        override fun onProgressChanged(view: WebView?, newProgress: Int) = onProgress(newProgress)

        override fun onShowFileChooser(
          webView: WebView?,
          filePathCallback: ValueCallback<Array<Uri>>,
          fileChooserParams: FileChooserParams,
        ) = onFileRequest(filePathCallback, fileChooserParams)
      }
    webViewClient =
      object : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
          onProgress(0)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
          onProgress(100)
          view?.let(onLoaded)
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
          if (request?.isForMainFrame == true) onError()
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
          if (!request.isForMainFrame) return false
          val uri = request.url
          if (uri.scheme == "https" && uri.host.equals(CD_WEB_HOST, ignoreCase = true)) return false
          return openExternal(activity, uri)
        }
      }
    loadUrl(initialCloudUrl(activity.intent.data))
  }

private fun initialCloudUrl(link: Uri?): String =
  if (link?.scheme == "https" && link.host.equals(CD_WEB_HOST, ignoreCase = true)) link.toString() else CD_WEB_URL

private fun fileIntent(parameters: WebChromeClient.FileChooserParams): Intent {
  val types = parameters.acceptTypes.filter { it.isNotBlank() && it.contains('/') }.distinct().toTypedArray()
  return Intent(Intent.ACTION_OPEN_DOCUMENT)
    .addCategory(Intent.CATEGORY_OPENABLE)
    .setType(if (types.size == 1) types[0] else "*/*")
    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
    .apply { if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types) }
}

private fun openExternal(activity: Activity, uri: Uri): Boolean {
  if (uri.scheme !in setOf("https", "http", "mailto", "tel")) return true
  return try {
    activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
    true
  } catch (_: ActivityNotFoundException) {
    Toast.makeText(activity, "No app can open this link.", Toast.LENGTH_SHORT).show()
    true
  }
}

@Composable
private fun CloudError(onRetry: () -> Unit) {
  Column(
    modifier = Modifier.fillMaxSize().background(CdBackground).padding(28.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.Start,
  ) {
    Text("CD", fontSize = 30.sp, fontWeight = FontWeight.Normal, letterSpacing = (-1).sp)
    Spacer(Modifier.height(48.dp))
    Text("Connection unavailable", fontSize = 25.sp, fontWeight = FontWeight.Normal)
    Spacer(Modifier.height(12.dp))
    Text(
      "CD couldn't reach the cloud transfer service. Check your connection and try again.",
      color = CdMuted,
      fontSize = 15.sp,
      lineHeight = 23.sp,
    )
    Spacer(Modifier.height(28.dp))
    Button(
      onClick = onRetry,
      modifier = Modifier.heightIn(min = 48.dp),
      shape = RoundedCornerShape(999.dp),
      colors = ButtonDefaults.buttonColors(containerColor = CdText, contentColor = CdBackground),
    ) {
      Text("Try again", fontWeight = FontWeight.Normal)
    }
  }
}
