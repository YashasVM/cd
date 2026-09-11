package `in`.yash0.cd.transfer

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import `in`.yash0.cd.data.HistoryStore
import `in`.yash0.cd.data.TransferState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** UI-facing owner of [TransferRepository]; survives rotation. */
class TransferViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = TransferRepository(app.applicationContext)
    private val historyStore = HistoryStore(app.applicationContext)

    val state = repo.state
    val code = repo.code
    val picked = repo.picked
    val manifest = repo.manifest
    val progress = repo.progress
    val error = repo.error
    val status = repo.status
    val history = historyStore.entries

    private val _qr = MutableStateFlow<Bitmap?>(null)
    val qr: StateFlow<Bitmap?> = _qr.asStateFlow()

    val receiveLink: String get() = TransferProtocol.receiveLink(code.value)

    init {
        // Re-mint the QR whenever the code rotates (e.g. ID-taken retry).
        viewModelScope.launch {
            combine(code, state) { c, s -> c to s }.collect { (c, s) ->
                if (c.isNotBlank() && s == TransferState.WAITING) {
                    _qr.value = runCatching { QrCodes.generate(TransferProtocol.receiveLink(c)) }.getOrNull()
                }
            }
        }
    }

    fun setPicked(uris: List<Uri>) {
        repo.setPickedUris(uris)
        _qr.value = null
    }

    fun host() {
        repo.host()
    }

    fun join(raw: String) = repo.join(raw)
    fun cancel() = repo.cancel()
    fun reset(keepPicked: Boolean = false) {
        repo.reset(keepPicked)
        if (!keepPicked) _qr.value = null
    }

    fun clearHistory() = viewModelScope.launch { historyStore.clear() }
}
