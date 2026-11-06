package main

import "testing"

func TestRelayStreamingIsExplicitlyOptIn(t *testing.T) {
	for _, flag := range []string{"", "0", "true", "1"} {
		t.Run(flag, func(t *testing.T) {
			t.Setenv("CD_RELAY_STREAMING", flag)
			want := "wss://example.test/ws/v1/transfer"
			if flag == "1" {
				want += "?stream=1"
			}
			if got := relayTransferEndpoint("wss://example.test/ws/v1", "transfer"); got != want {
				t.Fatalf("endpoint = %q, want %q", got, want)
			}
		})
	}
}

func TestStreamingQueryWorksWithOlderRelay(t *testing.T) {
	t.Setenv("CD_RELAY_STREAMING", "1")
	relay := newFakeRelay(t, "")
	ready := readyFrom(t, false)
	if ready.Code != "22222" {
		t.Fatalf("legacy relay code = %q", ready.Code)
	}
	if relay.claims.Load() != 1 {
		t.Fatalf("legacy claim count = %d", relay.claims.Load())
	}
}
