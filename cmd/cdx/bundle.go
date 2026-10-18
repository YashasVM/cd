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
		return shareSource{}, errors.New("missing file to send")
	}
	if len(paths) == 1 {
		if info, err := os.Stat(paths[0]); err == nil && info.IsDir() {
			return prepareBundle(paths)
		}
		return prepareFile(paths[0])
	}
	return prepareBundle(paths)
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
			return nil, errors.New("file changed while it was being sent")
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
			return shareSource{}, errors.New(`standard input ("-") is not supported: send files or folders`)
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
			return shareSource{}, fmt.Errorf("cannot access %q: %s", path, underlyingReason(err))
		}
		base := filepath.Base(absolute)
		if !utf8.ValidString(base) {
			return shareSource{}, fmt.Errorf("cannot share %q: its name is not valid UTF-8", path)
		}
		if previous, ok := topLevel[base]; ok {
			return shareSource{}, fmt.Errorf("%q and %q would both be named %q in the bundle: rename one or send its folder", previous, path, base)
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
			return shareSource{}, fmt.Errorf("%q is not a regular file or folder", path)
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
			return fmt.Errorf("cannot read %q: %s", path, underlyingReason(err))
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
			return fmt.Errorf("cannot share %q: its name is not valid UTF-8", path)
		}
		if !entry.IsDir() && !entry.Type().IsRegular() {
			skipped++
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("cannot read %q: %s", path, underlyingReason(err))
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
			return fmt.Errorf("%q changed while it was being sent", entry.path)
		}
	}
	return archive.Close()
}

func openBundleEntry(entry bundleEntry) (io.ReadCloser, error) {
	file, err := os.Open(entry.path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %q: %s", entry.path, underlyingReason(err))
	}
	return file, nil
}

// bundleSize counts stored data, local headers, descriptors, and the central
// directory. These sizes mirror archive/zip.Writer; CRCs change no lengths.
func bundleSize(entries []bundleEntry) (uint64, error) {
	const zip32Limit = 1<<32 - 1
	var offset, directory uint64
	for _, entry := range entries {
		if len(entry.name) > 1<<16-1 {
			return 0, errors.New("zip: FileHeader.Name too long")
		}
		if entry.size > 1<<63-1 {
			return 0, errors.New("file is too large to bundle")
		}
		extra := uint64(0)
		if !entry.modified.IsZero() {
			extra = 9
		} // extended modification time
		central := uint64(46+len(entry.name)) + extra
		size := entry.size
		dir := strings.HasSuffix(entry.name, "/")
		if dir {
			size = 0
		}
		if size >= zip32Limit || offset >= zip32Limit {
			central += 28
		}
		directory += central
		local := uint64(30+len(entry.name)) + extra + size
		if !dir {
			local += 16
			if size >= zip32Limit {
				local += 8
			}
		}
		if local > (1<<63-1)-offset-98 || directory > (1<<63-1)-offset-local-98 {
			return 0, errors.New("bundle is too large")
		}
		offset += local
	}
	end := uint64(22)
	if len(entries) >= 1<<16-1 || directory >= zip32Limit || offset >= zip32Limit {
		end += 76
	}
	return offset + directory + end, nil
}
