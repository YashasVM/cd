package main

import "testing"

func TestEndpointBaseRejectsUnsafeOverrides(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "https://example.com/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "https://cd.yash0.in")
	if _, _, err := endpointBase(); err == nil {
		t.Fatal("accepted an HTTP relay URL")
	}

	t.Setenv("CD_RELAY_URL", "wss://cd.yash0.in/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "https://example.com/prefix")
	if _, _, err := endpointBase(); err == nil {
		t.Fatal("accepted a public URL with a path prefix")
	}
}

func TestEndpointBaseRejectsInsecureRemoteAndCredentials(t *testing.T) {
	tests := []struct{ relay, public string }{
		{"ws://example.com/ws/v1", "https://cd.yash0.in"},
		{"wss://user:pass@example.com/ws/v1", "https://cd.yash0.in"},
		{"wss://cd.yash0.in/ws/v1", "http://example.com"},
		{"wss://cd.yash0.in/ws/v1", "https://user:pass@example.com"},
	}
	for _, test := range tests {
		t.Setenv("CD_RELAY_URL", test.relay)
		t.Setenv("CD_PUBLIC_URL", test.public)
		if _, _, err := endpointBase(); err == nil {
			t.Fatalf("accepted relay=%q public=%q", test.relay, test.public)
		}
	}
}

func TestEndpointBaseAllowsInsecureLoopbackForDevelopment(t *testing.T) {
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:8787/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:8787")
	if _, _, err := endpointBase(); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointBaseRejectsOriginsThatCannotServeTheInvitation(t *testing.T) {
	tests := []struct{ relay, public string }{
		{"wss://relay.example.com/ws/v1", "https://download.example.com"},
		{"wss://cd.yash0.in/ws/v1", "http://cd.yash0.in"},
		{"ws://127.0.0.1:8787/ws/v1", "http://127.0.0.1:4173"},
		{"wss://cd.yash0.in/wrong", "https://cd.yash0.in"},
		{"wss://cd.yash0.in", "https://cd.yash0.in"},
	}
	for _, test := range tests {
		t.Setenv("CD_RELAY_URL", test.relay)
		t.Setenv("CD_PUBLIC_URL", test.public)
		if _, _, err := endpointBase(); err == nil {
			t.Fatalf("accepted relay=%q public=%q", test.relay, test.public)
		}
	}
}

func TestSafeFilenameMatchesBrowserContract(t *testing.T) {
	valid, err := safeFilename("some/path/résumé final.pdf")
	if err != nil || valid != "résumé final.pdf" {
		t.Fatalf("safe filename = %q, %v", valid, err)
	}
	if base, err := safeFilename("some/dir/name.txt"); err != nil || base != "name.txt" {
		t.Fatalf("basename extraction = %q, %v", base, err)
	}
	for _, name := range []string{"bad\\name.txt", "line\nbreak.txt", "..", ".", "/"} {
		if _, err := safeFilename(name); err == nil {
			t.Fatalf("accepted unsafe filename %q", name)
		}
	}
}
