package `in`.yash0.cd

import `in`.yash0.cd.data.FileMeta
import `in`.yash0.cd.data.Manifest
import `in`.yash0.cd.transfer.PeerWire
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class MaxFileSizeTest {
    @Test
    fun acceptsTheWebMaximumFileSize() {
        val maxBytes = 5L * 1024 * 1024 * 1024
        assertEquals(maxBytes, PeerWire.MAX_FILE_BYTES)

        val manifest = Manifest(
            totalFiles = 1,
            totalSize = maxBytes,
            files = listOf(FileMeta(0, "large.bin", maxBytes)),
        )
        assertNotNull(PeerWire.parseManifest(PeerWire.manifestMap(manifest)))
    }
}
