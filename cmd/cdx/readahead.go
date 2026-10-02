package main

import "io"

// readAheadDepth is how many chunks the reader may fill ahead of the
// sender, so disk reads (and bundle zip/CRC work) overlap sealing and
// network writes instead of alternating with them.
const readAheadDepth = 4

type readAheadChunk struct {
	data []byte
	err  error
}

// readAhead reads source in size-byte chunks on its own goroutine. Each
// chunk's data is valid until it is handed back with recycle. The chunk
// carrying a non-nil err (io.EOF at the end) is the last one; its data may
// still hold the final partial chunk. Closing stop ends the goroutine early.
type readAhead struct {
	chunks chan readAheadChunk
	free   chan []byte
	stop   chan struct{}
}

func newReadAhead(source io.Reader, size int) *readAhead {
	ahead := &readAhead{chunks: make(chan readAheadChunk, readAheadDepth), free: make(chan []byte, readAheadDepth), stop: make(chan struct{})}
	for range readAheadDepth {
		ahead.free <- make([]byte, size)
	}
	go func() {
		for {
			var buffer []byte
			select {
			case buffer = <-ahead.free:
			case <-ahead.stop:
				return
			}
			count, err := io.ReadFull(source, buffer)
			if err == io.ErrUnexpectedEOF {
				err = io.EOF
			}
			select {
			case ahead.chunks <- readAheadChunk{data: buffer[:count], err: err}:
			case <-ahead.stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return ahead
}

func (ahead *readAhead) recycle(data []byte) {
	ahead.free <- data[:cap(data)]
}

func (ahead *readAhead) close() {
	close(ahead.stop)
}
