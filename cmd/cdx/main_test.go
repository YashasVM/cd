package main

import "testing"

func TestBrowserURLExtractsOnlyTheReceiveLink(t *testing.T) {
	line := "Or open: https://getcroc.com/?code=secret-code"
	if got := browserURL.FindString(line); got != "https://getcroc.com/?code=secret-code" {
		t.Fatalf("browser URL = %q", got)
	}
}

func TestCDShareURLUsesTheCDDomain(t *testing.T) {
	got, err := cdShareURL("https://getcroc.com/?code=baker-fog-lurk")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://cd.yash0.in/baker-fog-lurk" {
		t.Fatalf("CD URL = %q", got)
	}
}
