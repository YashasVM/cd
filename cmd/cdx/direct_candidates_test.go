package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

func TestTransferIncludesCandidatesDiscoveredWhileWaitingForReceiver(t *testing.T) {
	server, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, remote, err := server.ReadFrom(buffer)
			if err != nil {
				return
			}
			request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if request.Decode() != nil {
				continue
			}
			<-release
			reply, err := stun.Build(stun.NewTransactionIDSetter(request.TransactionID), stun.BindingSuccess,
				&stun.XORMappedAddress{IP: net.ParseIP("203.0.113.7"), Port: 50000})
			if err == nil {
				_, _ = server.WriteTo(reply.Raw, remote)
			}
		}
	}()
	old := directICEServers
	directICEServers = []webrtc.ICEServer{{URLs: []string{"stun:127.0.0.1:" + strconv.Itoa(server.LocalAddr().(*net.UDPAddr).Port)}}}
	defer func() { directICEServers = old }()
	sender, receiver, _ := linkedPair(t)
	path, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(path)
	initial, err := path.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(initial, " typ srflx") {
		t.Fatal("STUN replied before release")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(path.connection.LocalDescription().SDP, " typ srflx") {
		if time.Now().After(deadline) {
			t.Fatal("delayed STUN candidate was not gathered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	offers := make(chan string, 1)
	offers <- initial
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, bytes.NewReader(nil), readyOutput{Filename: "empty.bin"}, offers, sendHooks{})
	}()
	kind, payload, err := receiver.next(ctx, 2*time.Second)
	cancel()
	<-done
	if err != nil || kind != kindOffer {
		t.Fatalf("offer: %v %v", kind, err)
	}
	var offer fileOffer
	if err := json.Unmarshal(payload, &offer); err != nil {
		t.Fatal(err)
	}
	if offer.Direct == nil || !strings.Contains(offer.Direct.SDP, "203.0.113.7") {
		t.Fatal("file offer dropped the public candidate discovered while waiting for the receiver")
	}
}
