package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// shareSource is what one send streams: a single regular file as-is, or
// several files and folders as a zip built on the fly. The relay protocol
// offers one named byte stream of known size, so receivers (browser or
// terminal) need no changes: a bundle arrives as one .zip file.
type shareSource struct {
	name string
	size uint64
	// open starts the byte stream; call it once, when the receiver accepts.
	open func() (io.ReadCloser, error)
	// skipped counts symlinks and special files left out of a bundle.
	skipped int
	// files counts a bundle's regular files; zero for a single file.
	files int
}

// bundleEntry is one file or directory inside a zip bundle.
type bundleEntry struct {
	path     string
	name     string
	size     uint64
	mode     fs.FileMode
	modified time.Time
	dir      bool
}

func prepareSource(paths []string) (shareSource, error) {
	if len(paths) == 0 {
		return shareSource{}, NewFailure(failureLocal, "missing file to send", retryNever)
	}
	if len(paths) == 1 {
		if info, err := os.Stat(paths[0]); err == nil && info.IsDir() {
			return prepareBundle(paths)
		}
		return prepareFile(paths[0])
	}
	return prepareBundle(paths)
}

// validateSourcePaths checks the named inputs without walking their contents.
// The detached holder performs the full walk and ZIP sizing exactly once.
func validateSourcePaths(paths []string) error {
	if len(paths) == 0 {
		return NewFailure(failureLocal, "missing file to send", retryNever)
	}
	topLevel := make(map[string]string, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if path == "-" || path == "" || err != nil || !info.IsDir() {
			if _, err := prepareFile(path); err != nil {
				return err
			}
		} else {
			folder, err := os.Open(path)
			if err != nil {
				return failuref(failureLocal, retryNever, "cannot read %q: %s (check folder permissions)", path, underlyingReason(err))
			}
			_, err = folder.Readdirnames(1)
			_ = folder.Close()
			if err != nil && !errors.Is(err, io.EOF) {
				return failuref(failureLocal, retryNever, "cannot read %q: %s (check folder permissions)", path, underlyingReason(err))
			}
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		base := filepath.Base(absolute)
		if !utf8.ValidString(base) {
			return failuref(failureLocal, retryNever, "cannot share %q: its name is not valid UTF-8", path)
		}
		if previous, ok := topLevel[base]; ok {
			return failuref(failureLocal, retryNever, "%q and %q would both be named %q in the bundle: rename one or send its folder", previous, path, base)
		}
		topLevel[base] = path
	}
	return nil
}

func prepareFile(path string) (shareSource, error) {
	file, info, err := openSharedFile(path)
	if err != nil {
		return shareSource{}, err
	}
	_ = file.Close()
	name, err := safeFilename(path)
	if err != nil {
		return shareSource{}, err
	}
	size := uint64(info.Size())
	return shareSource{name: name, size: size, open: func() (io.ReadCloser, error) {
		file, current, err := openSharedFile(path)
		if err != nil {
			return nil, err
		}
		if uint64(current.Size()) != size {
			_ = file.Close()
			return nil, NewFailure(failureLocal, "file changed while it was being sent", retryNever)
		}
		return file, nil
	}}, nil
}

func prepareBundle(paths []string) (shareSource, error) {
	var entries []bundleEntry
	skipped := 0
	topLevel := map[string]string{}
	for _, path := range paths {
		if path == "-" {
			return shareSource{}, NewFailure(failureLocal, `standard input ("-") is not supported: send files or folders`, retryNever)
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return shareSource{}, err
		}
		info, err := os.Stat(absolute)
		if err != nil {
			// openSharedFile words missing and unreadable paths.
			if _, _, openErr := openSharedFile(path); openErr != nil {
				return shareSource{}, openErr
			}
			return shareSource{}, failuref(failureLocal, retryNever, "cannot access %q: %s", path, underlyingReason(err))
		}
		base := filepath.Base(absolute)
		if !utf8.ValidString(base) {
			return shareSource{}, failuref(failureLocal, retryNever, "cannot share %q: its name is not valid UTF-8", path)
		}
		if previous, ok := topLevel[base]; ok {
			return shareSource{}, failuref(failureLocal, retryNever, "%q and %q would both be named %q in the bundle: rename one or send its folder", previous, path, base)
		}
		topLevel[base] = path
		switch {
		case info.Mode().IsRegular():
			entries = append(entries, bundleEntry{path: absolute, name: base, size: uint64(info.Size()), mode: info.Mode(), modified: info.ModTime()})
		case info.IsDir():
			walked, walkSkipped, err := walkFolder(absolute, base)
			if err != nil {
				return shareSource{}, err
			}
			entries = append(entries, walked...)
			skipped += walkSkipped
		default:
			return shareSource{}, failuref(failureLocal, retryNever, "%q is not a regular file or folder", path)
		}
	}
	size, err := bundleSize(entries)
	if err != nil {
		return shareSource{}, err
	}
	files := 0
	for _, entry := range entries {
		if !entry.dir {
			files++
		}
	}
	return shareSource{name: bundleName(paths), size: size, skipped: skipped, files: max(files, 1), open: func() (io.ReadCloser, error) {
		reader, writer := io.Pipe()
		go func() {
			writer.CloseWithError(writeBundle(writer, entries, openBundleEntry))
		}()
		return reader, nil
	}}, nil
}

// walkFolder lists a folder's files and subfolders under prefix. Symlinks
// and special files are skipped, never followed: a link could pull in files
// far outside the folder the user named.
func walkFolder(root, prefix string) ([]bundleEntry, int, error) {
	var entries []bundleEntry
	skipped := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return failuref(failureLocal, retryNever, "cannot read %q: %s", path, underlyingReason(err))
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := prefix
		if relative != "." {
			name = prefix + "/" + filepath.ToSlash(relative)
		}
		if !utf8.ValidString(name) {
			return failuref(failureLocal, retryNever, "cannot share %q: its name is not valid UTF-8", path)
		}
		if !entry.IsDir() && !entry.Type().IsRegular() {
			skipped++
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return failuref(failureLocal, retryNever, "cannot read %q: %s", path, underlyingReason(err))
		}
		if entry.IsDir() {
			entries = append(entries, bundleEntry{path: path, name: name + "/", mode: info.Mode(), modified: info.ModTime(), dir: true})
			return nil
		}
		entries = append(entries, bundleEntry{path: path, name: name, size: uint64(info.Size()), mode: info.Mode(), modified: info.ModTime()})
		return nil
	})
	return entries, skipped, err
}

func bundleName(paths []string) string {
	first := "files"
	if absolute, err := filepath.Abs(paths[0]); err == nil {
		first = strings.TrimSuffix(filepath.Base(absolute), filepath.Ext(absolute))
	}
	name := first + ".zip"
	if len(paths) > 1 {
		name = fmt.Sprintf("%s-and-%d-more.zip", first, len(paths)-1)
	}
	if _, err := safeFilename(name); err != nil || first == "" || first == "." {
		return "files.zip"
	}
	return name
}

// writeBundle writes entries as an uncompressed zip. contents supplies each
// file's bytes; exactly entry.size bytes must come out of it.
func writeBundle(output io.Writer, entries []bundleEntry, contents func(bundleEntry) (io.ReadCloser, error)) error {
	archive := zip.NewWriter(output)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store, Modified: entry.modified}
		header.SetMode(entry.mode)
		if entry.dir {
			if _, err := archive.CreateHeader(header); err != nil {
				return err
			}
			continue
		}
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		reader, err := contents(entry)
		if err != nil {
			return err
		}
		copied, copyErr := io.CopyN(writer, reader, int64(entry.size))
		extra, _ := reader.Read(make([]byte, 1))
		_ = reader.Close()
		if copyErr != nil || copied != int64(entry.size) || extra != 0 {
			return failuref(failureLocal, retryNever, "%q changed while it was being sent", entry.path)
		}
	}
	return archive.Close()
}

func openBundleEntry(entry bundleEntry) (io.ReadCloser, error) {
	file, err := os.Open(entry.path)
	if err != nil {
		return nil, failuref(failureLocal, retryNever, "cannot read %q: %s", entry.path, underlyingReason(err))
	}
	return file, nil
}

// bundleSize runs writeBundle over zero-filled contents into a counter. Zip
// headers and sizes do not depend on the bytes, only the CRCs do, so the
// count is exact.
func bundleSize(entries []bundleEntry) (uint64, error) {
	var counter countingWriter
	err := writeBundle(&counter, entries, func(entry bundleEntry) (io.ReadCloser, error) {
		return io.NopCloser(io.LimitReader(zeroReader{}, int64(entry.size))), nil
	})
	return counter.count, err
}

type countingWriter struct{ count uint64 }

func (writer *countingWriter) Write(data []byte) (int, error) {
	writer.count += uint64(len(data))
	return len(data), nil
}

type zeroReader struct{}

func (zeroReader) Read(data []byte) (int, error) {
	clear(data)
	return len(data), nil
}
