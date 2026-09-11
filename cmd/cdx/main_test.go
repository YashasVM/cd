package main

import "testing"

func TestShareCodeHasFourWords(t *testing.T) {
	code, err := shareCode()
	if err != nil {
		t.Fatal(err)
	}
	parts := 0
	for index := 0; index < len(code); index++ {
		if code[index] == '-' {
			parts++
		}
	}
	if parts != 3 {
		t.Fatalf("share code %q has %d separators", code, parts)
	}
}
