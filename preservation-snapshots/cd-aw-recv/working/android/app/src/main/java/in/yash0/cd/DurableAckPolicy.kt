package `in`.yash0.cd

class DurableAckPolicy(windowBytes: Long) {
    val interval: Long = if (windowBytes >= 1048576L) 1048576L else 262144L
    fun commit(written: Long, committed: Long, size: Long): Boolean = written == size || written - committed >= interval
}
