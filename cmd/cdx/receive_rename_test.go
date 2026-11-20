package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUniqueReceiveName(t *testing.T) {
	t.Run("unused name", func(t *testing.T) {
		root, err := os.OpenRoot(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		if got, err := uniqueReceiveName(root, "report.pdf"); err != nil || got != "report.pdf" {
			t.Fatalf("uniqueReceiveName = %q, %v", got, err)
		}
	})

	t.Run("extension", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := uniqueReceiveName(root, "report.pdf"); err != nil || got != "report (2).pdf" {
			t.Fatalf("uniqueReceiveName = %q, %v", got, err)
		}
	})

	t.Run("no extension", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		if err := os.WriteFile(filepath.Join(dir, "README"), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := uniqueReceiveName(root, "README"); err != nil || got != "README (2)" {
			t.Fatalf("uniqueReceiveName = %q, %v", got, err)
		}
	})

	t.Run("dotfile", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := uniqueReceiveName(root, ".env"); err != nil || got != ".env (2)" {
			t.Fatalf("uniqueReceiveName = %q, %v", got, err)
		}
	})

	t.Run("multiple collisions", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		for _, name := range []string{"report.pdf", "report (2).pdf", "report (3).pdf"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if got, err := uniqueReceiveName(root, "report.pdf"); err != nil || got != "report (4).pdf" {
			t.Fatalf("uniqueReceiveName = %q, %v", got, err)
		}
	})

	t.Run("exhausts attempts", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		for n := 2; n <= uniqueNameMaxAttempts; n++ {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("report (%d).pdf", n)), []byte("x"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := uniqueReceiveName(root, "report.pdf"); err == nil {
			t.Fatal("exhausted candidates without an error")
		}
	})

	t.Run("name near byte limit", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		name := strings.Repeat("a", 251)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := uniqueReceiveName(root, name)
		if err != nil || got != name+" (2)" || len(got) > 255 {
			t.Fatalf("uniqueReceiveName = %q (len %d), %v", got, len(got), err)
		}
	})

	t.Run("rejects overlong candidate", func(t *testing.T) {
		dir := t.TempDir()
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		name := strings.Repeat("a", 253)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := uniqueReceiveName(root, name); err == nil {
			t.Fatal("accepted a name longer than 255 bytes")
		}
	})
}

func TestParseReceiveArgsRename(t *testing.T) {
	request, err := parseReceiveArgs([]string{"--rename", "code#v1.key"})
	if err != nil || !request.rename || request.force || request.code != "code#v1.key" {
		t.Fatalf("request = %#v, %v", request, err)
	}
	if _, err := parseReceiveArgs([]string{"--force", "--rename", "code#v1.key"}); err == nil ||
		!strings.Contains(err.Error(), "--force and --rename cannot be combined") {
		t.Fatalf("combined flags = %v", err)
	}
	if _, err := parseReceiveArgs([]string{"--ren", "code#v1.key"}); err == nil ||
		!strings.Contains(err.Error(), "did you mean --rename?") {
		t.Fatalf("--ren typo = %v", err)
	}
}

func TestReceiveRenamePolicyPicksUniqueName(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	dest, err := resolveReceiveDestWithPolicy("report.pdf", dir, receivePolicy{rename: true})
	if err != nil {
		t.Fatal(err)
	}
	defer dest.root.Close()
	if dest.name != "report (2).pdf" || dest.overwrite {
		t.Fatalf("destination = %q overwrite=%v", dest.name, dest.overwrite)
	}
}

func TestReceiveCollisionNonInteractiveReturnsExists(t *testing.T) {
	original := receiveInteractive
	receiveInteractive = func() bool { return false }
	t.Cleanup(func() { receiveInteractive = original })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := resolveReceiveDestWithPolicy("report.pdf", dir, receivePolicy{})
	if err == nil {
		t.Fatal("collision was accepted")
	}
	if classifyFailure(err) != failureExists {
		t.Fatalf("error kind = %s (%v)", classifyFailure(err), err)
	}
	if !strings.Contains(err.Error(), "--rename") {
		t.Fatalf("error does not mention --rename: %v", err)
	}
}

func TestReceiveCollisionPrompt(t *testing.T) {
	original := receiveInteractive
	receiveInteractive = func() bool { return true }
	t.Cleanup(func() { receiveInteractive = original })

	cases := []struct {
		name          string
		input         string
		wantName      string
		wantOverwrite bool
		wantCancel    bool
	}{
		{"default renames", "\n", "report (2).pdf", false, false},
		{"r renames", "r\n", "report (2).pdf", false, false},
		{"rename renames", "rename\n", "report (2).pdf", false, false},
		{"o overwrites", "o\n", "report.pdf", true, false},
		{"overwrite overwrites", "Overwrite\n", "report.pdf", true, false},
		{"c cancels", "c\n", "", false, true},
		{"cancel cancels", "cancel\n", "", false, true},
		{"eof cancels", "", "", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "report.pdf"), []byte("existing"), 0600); err != nil {
				t.Fatal(err)
			}
			originalStdin := os.Stdin
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.WriteString(tc.input); err != nil {
				t.Fatal(err)
			}
			writer.Close()
			os.Stdin = reader
			defer func() {
				os.Stdin = originalStdin
				reader.Close()
			}()

			dest, err := resolveReceiveDestWithPolicy("report.pdf", dir, receivePolicy{})
			if tc.wantCancel {
				if err == nil {
					if dest != nil {
						_ = dest.root.Close()
					}
					t.Fatal("cancel was not reported")
				}
				if classifyFailure(err) != failureCanceled {
					t.Fatalf("error kind = %s (%v)", classifyFailure(err), err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer dest.root.Close()
			if dest.name != tc.wantName || dest.overwrite != tc.wantOverwrite {
				t.Fatalf("destination = %q overwrite=%v, want %q overwrite=%v", dest.name, dest.overwrite, tc.wantName, tc.wantOverwrite)
			}
		})
	}
}
