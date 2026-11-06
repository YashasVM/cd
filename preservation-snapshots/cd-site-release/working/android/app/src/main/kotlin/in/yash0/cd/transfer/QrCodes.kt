package `in`.yash0.cd.transfer

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

/** Native QR generation (replaces the qrcode npm canvas). */
object QrCodes {
    fun generate(text: String, sizePx: Int = 512): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx)
        val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        for (x in 0 until sizePx) {
            for (y in 0 until sizePx) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) 0xFF0D0503.toInt() else 0xFFE4D4B6.toInt())
            }
        }
        return bmp
    }
}
