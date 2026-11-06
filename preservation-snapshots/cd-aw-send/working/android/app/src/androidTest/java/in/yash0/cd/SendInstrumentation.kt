package `in`.yash0.cd

import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import java.io.File
import org.json.JSONObject

/** Local emulator-only driver. No debug control entry points are shipped in the application. */
class SendInstrumentation : Instrumentation() {
    private lateinit var args: Bundle
    override fun onCreate(arguments: Bundle) { args = arguments; start() }
    override fun onStart() {
        try {
            val context = targetContext
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val engine = SendEngineImpl(context, args.getString("base", "http://127.0.0.1:8788"), args.getString("direct", "false") == "true")
            TransferBus.sender = engine
            if (args.getString("action") == "controls") { controls(engine); return }
            val id = if (args.getString("action", "start") == "resume") args.getString("id")!!.also { engine.resume(context, it) }
                else engine.start(context, listOf(Uri.fromFile(File(args.getString("source")!!))))
            File(context.filesDir, "send-test-id").writeText(id)
            val deadline = System.currentTimeMillis() + 15 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                val view = TransferBus.transfers.value.firstOrNull { it.id == id }
                if (view != null) {
                    File(context.filesDir, "send-test-status.json").writeText(JSONObject().put("id", id).put("phase", view.phase.name).put("done", view.done).put("link", view.link).put("rate", view.bytesPerSecond).put("route", view.route.name).put("message", view.message).toString())
                    if (view.phase == TransferPhase.COMPLETE) { finish(0, Bundle().apply { putString("result", "complete") }); return }
                    if (view.phase in listOf(TransferPhase.PAUSED, TransferPhase.FAILED)) error(view.message ?: view.phase.name)
                }
                Thread.sleep(50)
            }
            error("Timed out")
        } catch (e: Exception) { finish(1, Bundle().apply { putString("error", e.stackTraceToString()) }) }
    }
    private fun controls(engine: SendEngineImpl) {
        val file = File(targetContext.filesDir, "controls.txt").apply { writeText("sender control check") }
        val id = engine.start(targetContext, listOf(Uri.fromFile(file)))
        fun waitFor(phase: TransferPhase) {
            val deadline = System.currentTimeMillis() + 20000
            while (System.currentTimeMillis() < deadline) {
                if (TransferBus.transfers.value.first { it.id == id }.phase == phase) return
                Thread.sleep(20)
            }
            error("Expected $phase: ${TransferBus.transfers.value.first { it.id == id }}")
        }
        waitFor(TransferPhase.WAITING)
        engine.pause(targetContext, id)
        waitFor(TransferPhase.PAUSED)
        engine.resume(targetContext, id)
        waitFor(TransferPhase.WAITING)
        engine.cancel(targetContext, id)
        waitFor(TransferPhase.CANCELLED)
        Thread.sleep(500)
        check(SenderStore(targetContext).load(id).getString("phase") == "CANCELLED")
        check(!SenderStore(targetContext).source(id).exists())
        check(TransferBus.transfers.value.first { it.id == id }.phase == TransferPhase.CANCELLED)
        finish(0, Bundle().apply { putString("result", "pause, immediate resume, cancel, retained cancellation and source cleanup passed") })
    }
}
