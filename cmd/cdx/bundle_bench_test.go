package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Compare the old two-pass detached preparation with the current parent
// validation plus holder preparation, excluding fixture creation and relay I/O.
func BenchmarkDetachedPreparation(b *testing.B) {
	for _, files := range []int{1000, 10000} {
		b.Run(fmt.Sprintf("files-%d", files), func(b *testing.B) {
			root := b.TempDir()
			data := make([]byte, 4096)
			for i := 0; i < files; i++ {
				dir := filepath.Join(root, fmt.Sprintf("dir-%03d", i/100))
				if err := os.MkdirAll(dir, 0700); err != nil {
					b.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("file-%05d", i)), data, 0600); err != nil {
					b.Fatal(err)
				}
			}
			paths := []string{root}
			b.Run("before-two-preparations", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if _, err := prepareSource(paths); err != nil {
						b.Fatal(err)
					}
					if _, err := prepareSource(paths); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("after-validation-and-preparation", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if err := validateSourcePaths(paths); err != nil {
						b.Fatal(err)
					}
					if _, err := prepareSource(paths); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("parent-validation", func(b *testing.B) {
				b.ReportAllocs()
				for i := 0; i < b.N; i++ {
					if err := validateSourcePaths(paths); err != nil {
						b.Fatal(err)
					}
				}
			})
		})
	}
}
