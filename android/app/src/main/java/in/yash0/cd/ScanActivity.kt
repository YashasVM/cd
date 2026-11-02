package `in`.yash0.cd

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.ui.graphics.toArgb
import `in`.yash0.cd.ui.Cd
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/** ZXing owns camera permissions, decoding and lifecycle; CD supplies the chrome. */
class ScanActivity : CaptureActivity() {
    private lateinit var scannerSurface: DecoratedBarcodeView
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        scannerSurface.barcodeView.marginFraction = 0.05
        scannerSurface.cameraSettings = scannerSurface.cameraSettings.apply {
            isAutoFocusEnabled = true
            isContinuousFocusEnabled = true
        }
    }

    override fun initializeContent(): DecoratedBarcodeView {
        val density = resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radius).toFloat()
        }
        fun label(value: String, size: Float, color: Int) = TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color)
            typeface = resources.getFont(R.font.inter_regular)
            gravity = Gravity.CENTER_VERTICAL
            includeFontPadding = false
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Cd.bg.toArgb())
            setPadding(dp(20), dp(8), dp(20), dp(16))
            setOnApplyWindowInsetsListener { view, insets ->
                @Suppress("DEPRECATION")
                view.setPadding(dp(20) + insets.systemWindowInsetLeft, dp(8) + insets.systemWindowInsetTop,
                    dp(20) + insets.systemWindowInsetRight, dp(16) + insets.systemWindowInsetBottom)
                insets
            }
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("cd", 28f, Cd.text.toArgb()).apply {
            typeface = resources.getFont(R.font.jetbrains_mono_bold)
        }, LinearLayout.LayoutParams(0, dp(64), 1f))
        header.addView(label("", 30f, Cd.text.toArgb()).apply {
            gravity = Gravity.CENTER
            contentDescription = "Close scanner"
            isFocusable = true
            background = rounded(Cd.panel.toArgb(), 24)
            foreground = object : android.graphics.drawable.Drawable() {
                private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Cd.text.toArgb()
                    strokeWidth = dp(2).toFloat()
                    strokeCap = Paint.Cap.ROUND
                }
                override fun draw(canvas: Canvas) {
                    val cx = bounds.exactCenterX()
                    val cy = bounds.exactCenterY()
                    val half = dp(6).toFloat()
                    canvas.drawLine(cx - half, cy - half, cx + half, cy + half, stroke)
                    canvas.drawLine(cx + half, cy - half, cx - half, cy + half, stroke)
                }
                override fun setAlpha(alpha: Int) { stroke.alpha = alpha }
                override fun setColorFilter(filter: android.graphics.ColorFilter?) { stroke.colorFilter = filter }
                @Deprecated("Deprecated in Android")
                override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
            }
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(header)
        val landscape = resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        root.addView(label("Scan QR", if (landscape) 24f else 32f, Cd.text.toArgb()).apply {
            typeface = resources.getFont(R.font.inter_semibold)
        }, LinearLayout.LayoutParams(-1, dp(if (landscape) 40 else 64)))
        val camera = DecoratedBarcodeView(this).apply {
            viewFinder.visibility = View.GONE
            statusView.visibility = View.GONE
        }
        scannerSurface = camera
        val preview = FrameLayout(this).apply {
            background = rounded(Cd.panel.toArgb(), 24)
            clipToOutline = true
            addView(camera, FrameLayout.LayoutParams(-1, -1))
            val guides = object : View(this@ScanActivity) {
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Cd.accent.toArgb()
                    style = Paint.Style.STROKE
                    strokeWidth = dp(3).toFloat()
                    strokeCap = Paint.Cap.ROUND
                }
                override fun onDraw(canvas: Canvas) {
                    val frame = camera.barcodeView.framingRect ?: return
                    val left = frame.left.toFloat()
                    val top = frame.top.toFloat()
                    val arm = minOf(frame.width(), frame.height()) * 0.12f
                    for (x in listOf(left, frame.right.toFloat())) for (y in listOf(top, frame.bottom.toFloat())) {
                        canvas.drawLine(x, y, x + if (x == left) arm else -arm, y, paint)
                        canvas.drawLine(x, y, x, y + if (y == top) arm else -arm, paint)
                    }
                }
            }
            camera.barcodeView.addStateListener(object : com.journeyapps.barcodescanner.CameraPreview.StateListener {
                override fun previewSized() { guides.invalidate() }
                override fun previewStarted() { guides.invalidate() }
                override fun previewStopped() {}
                override fun cameraError(error: Exception) {}
                override fun cameraClosed() {}
            })
            addView(guides, FrameLayout.LayoutParams(-1, -1))
        }
        root.addView(preview, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(label("Point at a CD QR code", 15f, Cd.muted.toArgb()).apply {
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(56)))
        setContentView(root)
        return camera
    }
}
