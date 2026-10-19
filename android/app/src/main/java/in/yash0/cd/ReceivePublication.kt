package `in`.yash0.cd

object ReceivePublication {
    enum class State { PENDING, PUBLISHED, MISSING, UNKNOWN }

    /** Cancellation may discard a pending copy, never a saved file or an unknown row. */
    fun discardPending(state: () -> State, delete: () -> Int): Boolean = when (state()) {
        State.PENDING -> delete() == 1
        State.PUBLISHED, State.MISSING -> true
        State.UNKNOWN -> false
    }
}
