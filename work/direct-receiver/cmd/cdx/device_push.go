package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/YashasVM/cd/internal/devices"
)

// Wake-up is an optional hint. Admission and file authentication still happen
// through the paired control channel, even if this endpoint accepts the hint.
func requestDeviceWake(ctx context.Context, pair devices.Pair) {
	endpoint, err := url.Parse(pair.RelayURL)
	if err != nil || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return
	}
	switch endpoint.Scheme {
	case "wss":
		endpoint.Scheme = "https"
	case "ws":
		if endpoint.Hostname() != "127.0.0.1" && endpoint.Hostname() != "::1" {
			return
		}
		endpoint.Scheme = "http"
	default:
		return
	}
	join, err := pair.Join(devices.Sender)
	if err != nil {
		return
	}
	endpoint.Path = "/api/devices/v1/" + pair.PairID + "/push"
	endpoint.RawPath = ""
	payload, err := json.Marshal(struct {
		Version int    `json:"v"`
		Token   string `json:"token"`
		Reason  string `json:"reason"`
	}{1, join.Token, "offer"})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
}

func deviceWakeLoop(ctx context.Context, pair devices.Pair) {
	// Give the normal LAN and relay connections time to meet before using FCM.
	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			requestDeviceWake(ctx, pair)
			timer.Reset(35 * time.Second)
		}
	}
}
