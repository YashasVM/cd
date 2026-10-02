package main

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestReadAheadReturnsEveryByteInOrder(t *testing.T) {
	source := make([]byte, 10*1000+7)
	for index := range source {
		source[index] = byte(index)
	}
	ahead := newReadAhead(bytes.NewReader(source), 1000)
	defer ahead.close()
	var got []byte
	for {
		chunk := <-ahead.chunks
		got = append(got, chunk.data...)
		ahead.recycle(chunk.data)
		if chunk.err != nil {
			if chunk.err != io.EOF {
				t.Fatal(chunk.err)
			}
			break
		}
	}
	if !bytes.Equal(got, source) {
		t.Fatalf("got %d bytes, want %d in order", len(got), len(source))
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("disk gone") }

func TestReadAheadReportsReadErrors(t *testing.T) {
	ahead := newReadAhead(failingReader{}, 1000)
	defer ahead.close()
	if chunk := <-ahead.chunks; chunk.err == nil || chunk.err == io.EOF {
		t.Fatalf("err = %v, want the read error", chunk.err)
	}
}
