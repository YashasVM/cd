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
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Cd.bg.toArgb())
            fitsSystemWindows = true
            setPadding(dp(20), dp(8), dp(20), dp(16))
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("cd", 28f, Cd.text.toArgb()).apply {
            typeface = resources.getFont(R.font.jetbrains_mono_bold)
        }, LinearLayout.LayoutParams(0, dp(64), 1f))
        header.addView(label("×", 30f, Cd.text.toArgb()).apply {
            gravity = Gravity.CENTER
            contentDescription = "Close scanner"
            isFocusable = true
            background = rounded(Cd.panel.toArgb(), 24)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(header)
        root.addView(label("Scan QR", 32f, Cd.text.toArgb()).apply {
            typeface = resources.getFont(R.font.inter_semibold)
        }, LinearLayout.LayoutParams(-1, dp(64)))
        val camera = DecoratedBarcodeView(this).apply {
            viewFinder.visibility = View.GONE
            statusView.visibility = View.GONE
        }
        scannerSurface = camera
        val preview = FrameLayout(this).apply {
            background = rounded(Cd.panel.toArgb(), 24)
            clipToOutline = true
            addView(camera, FrameLayout.LayoutParams(-1, -1))
            addView(object : View(this@ScanActivity) {
                override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
                    super.onSizeChanged(w, h, oldw, oldh)
                    postInvalidateDelayed(300)
                }
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Cd.accent.toArgb()
                    style = Paint.Style.STROKE
                    strokeWidth = dp(3).toFloat()
                    strokeCap = Paint.Cap.ROUND
                }
                override fun onDraw(canvas: Canvas) {
                    val frame = camera.barcodeView.framingRect ?: return
                    val side = minOf(frame.width(), frame.height()).toFloat()
                    val left = frame.left.toFloat()
                    val top = frame.top.toFloat()
                    val arm = side * 0.12f
                    for (x in listOf(left, left + side)) for (y in listOf(top, top + side)) {
                        canvas.drawLine(x, y, x + if (x == left) arm else -arm, y, paint)
                        canvas.drawLine(x, y, x, y + if (y == top) arm else -arm, paint)
                    }
                }
            }, FrameLayout.LayoutParams(-1, -1))
        }
        root.addView(preview, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(label("Point at a CD QR code", 15f, Cd.muted.toArgb()).apply {
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(56)))
        setContentView(root)
        return camera
    }
}
