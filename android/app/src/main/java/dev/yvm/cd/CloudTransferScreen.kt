package dev.yvm.cd

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.view.View
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.json.JSONObject

internal const val CD_WEB_URL = "https://cd.yvm.workers.dev/"
internal const val CD_WEB_ORIGIN = "https://cd.yvm.workers.dev"
private const val CD_WEB_HOST = "cd.yvm.workers.dev"
private const val DOWNLOAD_BRIDGE = "CDNative"

@Composable
internal fun CloudTransferScreen(visible: Boolean, modifier: Modifier = Modifier) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val activity = context as Activity
  val lifecycleOwner = LocalLifecycleOwner.current
  val downloadSink = remember(activity) { CloudDownloadSink(activity) }
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
          downloadSink = downloadSink,
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
      webView?.let {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
          WebViewCompat.removeWebMessageListener(it, DOWNLOAD_BRIDGE)
        }
      }
      webView?.stopLoading()
      webView?.destroy()
      webView = null
      downloadSink.close()
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
  downloadSink: CloudDownloadSink,
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
    installDownloadBridge(this, downloadSink)
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
          if (
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
              !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
          ) {
            view?.evaluateJavascript(DOWNLOAD_HOOK, null)
          }
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

private fun installDownloadBridge(webView: WebView, sink: CloudDownloadSink) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
  WebViewCompat.addWebMessageListener(
    webView,
    DOWNLOAD_BRIDGE,
    setOf(CD_WEB_ORIGIN),
  ) { _, message, sourceOrigin, isMainFrame, _ ->
    if (isMainFrame && sourceOrigin.toString() == CD_WEB_ORIGIN) {
      message.data?.let(sink::post)
    }
  }
  if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    WebViewCompat.addDocumentStartJavaScript(webView, DOWNLOAD_HOOK, setOf(CD_WEB_ORIGIN))
  }
}

private data class CloudDownload(val uri: Uri, val name: String, val stream: OutputStream)

private class CloudDownloadSink(private val activity: Activity) {
  private val downloads = ConcurrentHashMap<String, CloudDownload>()
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var closed = false

  fun post(message: String) {
    if (closed) return
    try {
      worker.execute { handle(message) }
    } catch (_: RejectedExecutionException) {
      // Activity is already closing.
    }
  }

  fun close() {
    if (closed) return
    closed = true
    worker.execute { downloads.keys.toList().forEach(::abort) }
    worker.shutdown()
  }

  private fun handle(message: String) {
    runCatching {
      val json = JSONObject(message)
      val id = json.optString("id")
      if (!id.matches(Regex("[A-Za-z0-9._-]{1,80}"))) return
      when (json.optString("type")) {
        "begin" -> begin(id, json.optString("name"), json.optString("mime"))
        "chunk" -> append(id, json.getString("data"))
        "finish" -> finish(id)
        "abort" -> abort(id)
        "error" -> notify("The received file couldn't be saved.")
      }
    }.onFailure {
      notify("The received file couldn't be saved.")
    }
  }

  private fun begin(id: String, rawName: String, rawMime: String) {
    abort(id)
    val name = safeDownloadName(rawName)
    val values =
      ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, rawMime.ifBlank { "application/octet-stream" })
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/CD")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
    var uri: Uri? = null
    try {
      uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: error("Could not create download")
      val stream = activity.contentResolver.openOutputStream(uri) ?: error("Could not open download")
      downloads[id] = CloudDownload(uri, name, stream)
    } catch (_: Exception) {
      uri?.let { activity.contentResolver.delete(it, null, null) }
      notify("Couldn't save the received file.")
    }
  }

  private fun append(id: String, encoded: String) {
    val download = downloads[id] ?: return
    try {
      download.stream.write(Base64.decode(encoded, Base64.DEFAULT))
    } catch (_: Exception) {
      abort(id)
      notify("The received file couldn't be saved.")
    }
  }

  private fun finish(id: String) {
    val download = downloads.remove(id) ?: return
    try {
      download.stream.close()
      activity.contentResolver.update(
        download.uri,
        ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
        null,
        null,
      )
      notify("${download.name} saved to Downloads/CD")
    } catch (_: Exception) {
      activity.contentResolver.delete(download.uri, null, null)
      notify("The received file couldn't be saved.")
    }
  }

  private fun abort(id: String) {
    val download = downloads.remove(id) ?: return
    runCatching { download.stream.close() }
    runCatching { activity.contentResolver.delete(download.uri, null, null) }
  }

  private fun notify(message: String) = activity.runOnUiThread {
    if (!activity.isDestroyed) Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
  }
}

private fun safeDownloadName(name: String) =
  name.substringAfterLast('/').substringAfterLast('\\').filterNot(Char::isISOControl).take(180).ifBlank { "download" }

private const val DOWNLOAD_HOOK =
  """
  (() => {
    if (window.__cdAndroidDownloadHook || !window.CDNative) return;
    window.__cdAndroidDownloadHook = true;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const anchor = this;
      if (!anchor.href.startsWith('blob:') || !anchor.download) return originalClick.call(anchor);
      (async () => {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random();
        try {
          const blob = await fetch(anchor.href).then(response => response.blob());
          CDNative.postMessage(JSON.stringify({ type: 'begin', id, name: anchor.download, mime: blob.type }));
          const reader = blob.stream().getReader();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            for (let offset = 0; offset < result.value.length; offset += 48 * 1024) {
              const chunk = result.value.subarray(offset, Math.min(offset + 48 * 1024, result.value.length));
              let binary = '';
              for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
              CDNative.postMessage(JSON.stringify({ type: 'chunk', id, data: btoa(binary) }));
            }
          }
          CDNative.postMessage(JSON.stringify({ type: 'finish', id }));
        } catch (_) {
          CDNative.postMessage(JSON.stringify({ type: 'abort', id }));
          CDNative.postMessage(JSON.stringify({ type: 'error', id }));
        }
      })();
    };
  })();
  """

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
