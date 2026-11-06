package `in`.yash0.cd.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.historyStore by preferencesDataStore("cd_history")

data class HistoryEntry(
    val id: Long = System.currentTimeMillis(),
    val direction: String,
    val title: String,
    val detail: String,
    val atMs: Long = System.currentTimeMillis(),
)

/** Lightweight transfer history (native-only feature; the web app keeps none). */
class HistoryStore(private val context: Context) {
    private val key = stringPreferencesKey("entries")

    val entries: Flow<List<HistoryEntry>> = context.historyStore.data.map { prefs ->
        val raw = prefs[key] ?: return@map emptyList()
        runCatching {
            val arr = JSONArray(raw)
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                HistoryEntry(
                    id = o.optLong("id"),
                    direction = o.optString("direction"),
                    title = o.optString("title"),
                    detail = o.optString("detail"),
                    atMs = o.optLong("atMs"),
                )
            }.sortedByDescending { it.atMs }
        }.getOrDefault(emptyList())
    }

    suspend fun add(entry: HistoryEntry) {
        val current = entries.first().toMutableList()
        current.add(0, entry)
        val trimmed = current.take(50)
        val arr = JSONArray()
        trimmed.forEach {
            arr.put(JSONObject().apply {
                put("id", it.id)
                put("direction", it.direction)
                put("title", it.title)
                put("detail", it.detail)
                put("atMs", it.atMs)
            })
        }
        context.historyStore.edit { it[key] = arr.toString() }
    }

    suspend fun clear() {
        context.historyStore.edit { it.remove(key) }
    }
}
