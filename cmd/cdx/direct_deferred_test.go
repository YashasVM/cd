package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

func TestDeferredHelloRequiresExplicitExactCapability(t *testing.T) {
	for _, payload := range []string{
		`{}`, `{"deferredOffer":true}`, `{"candidate":{"candidate":""}}`,
		`{"candidate":{"candidate":"candidate:remote"},"deferredOffer":true}`,
		`{"candidate":{"candidate":""},"deferredOffer":true,"sdp":"answer"}`,
		`{"candidate":{},"deferredOffer":"true"}`, strings.Repeat(" ", 1025),
	} {
		if isDeferredDirectHello([]byte(payload)) {
			t.Fatalf("accepted unsupported capability %q", payload)
		}
	}
	if !isDeferredDirectHello([]byte(`{"candidate":{"candidate":""},"deferredOffer":true}`)) {
		t.Fatal("modern receiver hello rejected")
	}
}

func TestDeferredSenderKindIsStillRejectedWithoutScopedNegotiation(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	if _, err := sealer.sealInto(nil, kindSignal, []byte(`{"sdp":"x"}`)); err == nil {
		t.Fatal("sender signaling allowed before authenticated negotiation")
	}
	sealer.allowDirectSignal = true
	record, err := sealer.sealInto(nil, kindSignal, []byte(`{"sdp":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	opener, _ := newOpener(testInvitation(), senderDirection)
	if _, _, err = opener.open(record); err == nil {
		t.Fatal("receiver accepted sender signaling before pending offer")
	}
	opener.allowDirectSignal = true
	if kind, _, err := opener.open(record); err != nil || kind != kindSignal {
		t.Fatalf("negotiated sender signal: %d %v", kind, err)
	}
}

func TestLegacyReceiverStillWaitsForFullDirectSDP(t *testing.T) {
	sender, _, _ := linkedPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	offers := make(chan string, 1)
	done := make(chan string, 1)
	go func() {
		state, sdp, err := prepareDirectOffer(ctx, sender, offers)
		if err == nil && state.pending == nil {
			done <- sdp
		}
	}()
	select {
	case <-done:
		t.Fatal("legacy receiver received incomplete direct offer")
	case <-time.After(20 * time.Millisecond):
	}
	offers <- "complete public SDP"
	select {
	case sdp := <-done:
		if sdp != "complete public SDP" {
			t.Fatal("legacy SDP changed")
		}
	case <-ctx.Done():
		t.Fatal("legacy receiver never received gathered SDP")
	}
}

func TestDeferredOfferStartsDataBeforeGatheringAndNeverSignalsAfterEND(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	offers := make(chan string, 1)
	original := bytes.Repeat([]byte{0x37}, 1024*1024)
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, bytes.NewReader(original), readyOutput{Filename: "fast.bin", Size: uint64(len(original))}, offers, sendHooks{})
	}()
	if err := advertiseDeferredDirect(receiver); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(ctx, 200*time.Millisecond)
	if err != nil || kind != kindOffer {
		t.Fatalf("file offer waited for gathering: %d %v", kind, err)
	}
	offer, size, err := parseReceivedOffer(payload)
	if err != nil || !offer.DirectPending || offer.Direct != nil {
		t.Fatalf("pending offer: %+v %v", offer, err)
	}
	receiver.opener.allowDirectSignal = true
	if err := receiver.send(kindAccept, nil); err != nil {
		t.Fatal(err)
	}
	var received bytes.Buffer
	var chunks uint32
	for {
		kind, payload, err = receiver.next(ctx, 200*time.Millisecond)
		if err != nil {
			t.Fatal("data waited for gathering:", err)
		}
		if kind == kindEnd {
			break
		}
		if kind != kindChunk {
			t.Fatalf("unexpected pre-completion kind %d", kind)
		}
		received.Write(payload)
		chunks++
	}
	if uint64(received.Len()) != size || !bytes.Equal(received.Bytes(), original) {
		t.Fatal("early data changed")
	}
	// Complete gathering while the sender is still awaiting COMPLETE. This
	// must not enqueue a control frame behind END.
	offers <- "gathering completed after END"
	if kind, _, err := receiver.next(ctx, 20*time.Millisecond); err == nil || !isTimeoutError(err) {
		t.Fatalf("late frame after END: %d %v", kind, err)
	}
	if err := receiver.send(kindComplete, encodeCounts(chunks, size)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDeferredPublicSDPWakesBlockedACKWait(t *testing.T) {
	server, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	release := make(chan struct{})
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
	if !sender.attachDirect(path) {
		t.Fatal("cannot attach direct path")
	}
	offers := make(chan string, 1)
	go func() { sdp, _ := path.createOffer(); offers <- sdp }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	original := bytes.Repeat([]byte{0x37}, 2*minSendWindow)
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, bytes.NewReader(original), readyOutput{Filename: "public.bin", Size: uint64(len(original))}, offers, sendHooks{})
	}()
	if err := advertiseDeferredDirect(receiver); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(ctx, 250*time.Millisecond)
	if err != nil || kind != kindOffer {
		t.Fatalf("STUN blocked initial file offer: %d %v", kind, err)
	}
	var offer fileOffer
	if json.Unmarshal(payload, &offer) != nil || !offer.DirectPending {
		t.Fatal("file offer did not negotiate late SDP")
	}
	receiver.opener.allowDirectSignal = true
	if err := receiver.send(kindAccept, nil); err != nil {
		t.Fatal(err)
	}
	var received uint64
	for received < minSendWindow {
		kind, payload, err = receiver.next(ctx, time.Second)
		if err != nil || kind != kindChunk {
			t.Fatalf("initial data blocked: %d %v", kind, err)
		}
		received += uint64(len(payload))
	}
	// No ACK has been sent. The sender's window is full and its main
	// state machine must wake for SDP readiness, not wait for another ACK.
	close(release)
	kind, payload, err = receiver.next(ctx, time.Second)
	if err != nil || kind != kindSignal {
		t.Fatalf("SDP readiness did not wake ACK wait: %d %v", kind, err)
	}
	var signal directSignal
	if json.Unmarshal(payload, &signal) != nil || !strings.Contains(signal.SDP, "203.0.113.7") || !strings.Contains(signal.SDP, " typ srflx") {
		t.Fatal("deferred SDP omitted the public candidate")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestDeferredPreparationAndACKWaitCancelPromptly(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, _, err := prepareDirectOffer(ctx, sender, make(chan string)); done <- err }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("prepare cancellation: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	state := &deferredDirectOffer{pending: make(chan string)}
	go func() { _, _, err := state.next(ctx, receiver, time.Minute); done <- err }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("ACK wait cancellation: %v", err)
	}
}

func TestDeferredReceiverBoundsAndValidatesLateOffer(t *testing.T) {
	_, receiver, _ := linkedPair(t)
	for _, payload := range []string{
		`{}`, `{"sdp":""}`, `{"sdp":5}`, `{"sdp":"offer","candidate":{}}`,
		`{"sdp":"offer","deferredOffer":true}`, `{"sdp":"` + strings.Repeat("x", maxSDPBytes+1) + `"}`,
		strings.Repeat("x", 2*maxSDPBytes+1),
	} {
		if receiveDeferredDirect(receiver, []byte(payload)) == nil {
			t.Fatalf("accepted invalid late SDP of length %d", len(payload))
		}
	}
}

// A receiver talking to a sender/Worker without the capability hint must never
// emit the new pre-offer record. The mock sender keeps its default strict codec
// and accepts only the original ACCEPT, CHUNK, END, COMPLETE exchange.
func TestLegacyAdmissionKeepsCurrentReceiverOnOriginalWire(t *testing.T) {
	for _, mode := range []string{"", "unknown-future-mode"} {
		t.Run("mode="+mode, func(t *testing.T) {
			value := testInvitation()
			original := []byte("legacy sender, current receiver")
			errorsFromSender := make(chan error, 1)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				connection, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
				if err != nil {
					errorsFromSender <- err
					return
				}
				defer connection.Close()
				fail := func(err error) { errorsFromSender <- err }
				var join map[string]string
				if err := connection.ReadJSON(&join); err != nil {
					fail(err)
					return
				}
				if err := connection.WriteJSON(relayEvent{Type: "accepted", Protocol: "cd-transfer-v1", DirectOfferMode: mode}); err != nil {
					fail(err)
					return
				}
				sealer, _ := newSealer(value, senderDirection)
				opener, _ := newOpener(value, receiverDirection)
				send := func(kind messageKind, payload []byte) error {
					record, err := sealer.sealInto(nil, kind, payload)
					if err != nil {
						return err
					}
					return connection.WriteMessage(websocket.BinaryMessage, record)
				}
				offer, _ := json.Marshal(fileOffer{Name: "legacy.bin", MediaType: "application/octet-stream", Size: strconv.Itoa(len(original)), ChunkSize: chunkSize})
				if err := send(kindOffer, offer); err != nil {
					fail(err)
					return
				}
				_, record, err := connection.ReadMessage()
				if err != nil {
					fail(err)
					return
				}
				kind, _, err := opener.open(record)
				if err != nil || kind != kindAccept {
					fail(fmt.Errorf("legacy sender received pre-offer signal: %d %v", kind, err))
					return
				}
				if err := send(kindChunk, original); err != nil {
					fail(err)
					return
				}
				if err := send(kindEnd, encodeCounts(1, uint64(len(original)))); err != nil {
					fail(err)
					return
				}
				for {
					_, record, err = connection.ReadMessage()
					if err != nil {
						fail(err)
						return
					}
					kind, _, err = opener.open(record)
					if err != nil {
						fail(err)
						return
					}
					if kind == kindComplete {
						break
					}
					if kind != kindAck {
						fail(fmt.Errorf("unexpected legacy receive kind %d", kind))
						return
					}
				}
				_ = connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "done"), time.Now().Add(time.Second))
				errorsFromSender <- nil
			}))
			defer server.Close()
			t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/v1")
			t.Setenv("CD_PUBLIC_URL", server.URL)
			out := filepath.Join(t.TempDir(), "received.bin")
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := receiveFile(ctx, value.encodedID()+"#v1."+value.encodedKey(), out, false, func(receiveResult) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if err := <-errorsFromSender; err != nil {
				t.Fatal(err)
			}
			received, err := os.ReadFile(out)
			if err != nil || !bytes.Equal(received, original) {
				t.Fatalf("legacy output: %q %v", received, err)
			}
		})
	}
}

func TestRetiredDirectGatherWithoutLocalDescriptionDoesNotPanic(t *testing.T) {
	path, err := newDirectPath(func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatal(err)
	}
	path.retire()
	if sdp := path.localDescription(); sdp != "" {
		t.Fatal("retired uninitialized path produced SDP")
	}
}
