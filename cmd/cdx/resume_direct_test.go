package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type resumeTestFrame struct {
	data   []byte
	direct bool
	err    error
}
type resumeDirectResult struct {
	relayChunks, directChunks int
	err                       error
}

func TestResumableTransferSwitchesPionOnlyAfterDurableRelayDrain(t *testing.T) {
	for _, forceRelay := range []bool{false, true} {
		name := "pion"
		if forceRelay {
			name = "forced relay"
		}
		t.Run(name, func(t *testing.T) {
			saved := directICEServers
			directICEServers = []webrtc.ICEServer{}
			t.Cleanup(func() { directICEServers = saved })
			if forceRelay {
				t.Setenv("CD_DIRECT", "0")
			} else {
				t.Setenv("CD_DIRECT", "1")
			}
			t.Setenv("CD_STATE_DIR", t.TempDir())
			t.Setenv("CD_RELAY_URL", "wss://cd.yash0.in/ws/v1")
			t.Setenv("CD_PUBLIC_URL", "https://cd.yash0.in")
			output := deviceTestOutput(t)
			source, want := deviceSource(t, 12*1024*1024+17)
			left, right, _ := relayPair(t)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			result := make(chan resumeDirectResult, 1)
			request := sendRequest{files: []string{source}, jsonOutput: true, deviceConnect: func(_ context.Context, invite invitation, _ []byte, expiry int64, _ readyOutput, _ string) (*resumeSession, error) {
				sn, _ := resumeRandom()
				rn, _ := resumeRandom()
				seal, _ := newResumeSealer(invite, sn, rn, senderDirection)
				open, _ := newResumeOpener(invite, sn, rn, receiverDirection)
				receiverSeal, _ := newResumeSealer(invite, sn, rn, receiverDirection)
				receiverOpen, _ := newResumeOpener(invite, sn, rn, senderDirection)
				sender := &resumeSession{socket: left, seal: seal, open: open, expiresAt: expiry, senderNonce: resumeEncoded(sn), receiverNonce: resumeEncoded(rn)}
				receiver := &resumeSession{socket: right, seal: receiverSeal, open: receiverOpen, expiresAt: expiry}
				go func() { result <- receivePionResumeTest(ctx, receiver, want, forceRelay) }()
				return sender, nil
			}}
			if err := sendResumable(ctx, request); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-result:
				if got.err != nil {
					t.Fatal(got.err)
				}
				if got.relayChunks == 0 {
					t.Fatal("transfer did not start on relay")
				}
				if forceRelay && got.directChunks != 0 {
					t.Fatal("forced relay used direct data")
				}
				if !forceRelay && got.directChunks == 0 {
					t.Fatal("negotiated Pion channel never carried chunks")
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			log := deviceOutputBytes(t, output)
			if forceRelay && bytes.Contains(log, []byte("webrtc")) {
				t.Fatal("forced relay claimed WebRTC route")
			}
			if !forceRelay && !bytes.Contains(log, []byte(`"route":"peer-to-peer"`)) {
				t.Fatalf("direct switch missing route event: %s", log)
			}
		})
	}
}

func receivePionResumeTest(ctx context.Context, session *resumeSession, want []byte, forceRelay bool) (result resumeDirectResult) {
	fail := func(err error) resumeDirectResult { session.socket.Close(); result.err = err; return result }
	frames := make(chan resumeTestFrame, 64)
	deliver := func(frame resumeTestFrame) {
		select {
		case frames <- frame:
		case <-ctx.Done():
		}
	}
	go func() {
		for {
			kind, data, err := session.socket.ReadMessage()
			if err != nil {
				deliver(resumeTestFrame{err: err})
				return
			}
			if kind != websocket.BinaryMessage {
				deliver(resumeTestFrame{err: errors.New("unexpected relay text")})
				return
			}
			deliver(resumeTestFrame{data: data})
		}
	}()
	next := func() (messageKind, []byte, bool, error) {
		select {
		case f := <-frames:
			if f.err != nil {
				return 0, nil, false, f.err
			}
			kind, data, err := session.open.open(f.data)
			return kind, data, f.direct, err
		case <-ctx.Done():
			return 0, nil, false, ctx.Err()
		}
	}
	kind, data, viaDirect, err := next()
	if err != nil || kind != kindOffer || viaDirect {
		return fail(fmt.Errorf("initial offer: kind=%d direct=%v error=%v", kind, viaDirect, err))
	}
	var offer resumeOffer
	if err = json.Unmarshal(data, &offer); err != nil {
		return fail(err)
	}
	if forceRelay && offer.Direct != nil {
		return fail(errors.New("forced relay advertised direct SDP"))
	}
	if !forceRelay && offer.Direct == nil {
		return fail(errors.New("eligible transfer omitted direct SDP"))
	}
	var path *directPath
	var answer string
	if offer.Direct != nil {
		path, err = newDirectPath(func(record []byte) { deliver(resumeTestFrame{data: record, direct: true}) }, func(error) {})
		if err != nil {
			return fail(err)
		}
		defer path.close()
		path.assembler.version = resumeVersion
		answer, err = path.answerOffer(offer.Direct.SDP, nil)
		if err != nil {
			return fail(err)
		}
	}
	// Resume from an offset not aligned to the receiver's one-MiB ACK interval.
	// This catches a sender that drains at an absolute file boundary instead.
	offset := uint64(chunkSize)
	actual := append([]byte(nil), want[:offset]...)
	prefix := sha256.Sum256(actual)
	accept, _ := json.Marshal(map[string]any{"offset": strconv.FormatUint(offset, 10), "prefixSha256": hex.EncodeToString(prefix[:]), "ackEveryBytes": 1024 * 1024})
	if err = session.send(kindAccept, accept); err != nil {
		return fail(err)
	}
	committed := offset
	initial := offset
	answered := false
	switched := false
	for {
		kind, data, viaDirect, err = next()
		if err != nil {
			return fail(err)
		}
		switch kind {
		case kindChunk:
			if viaDirect {
				if !switched && committed != offset {
					return fail(fmt.Errorf("direct overtook unacknowledged relay prefix: committed=%d received=%d", committed, offset))
				}
				switched = true
				result.directChunks++
			} else {
				if switched {
					return fail(errors.New("relay chunk arrived after direct switch"))
				}
				result.relayChunks++
			}
			actual = append(actual, data...)
			offset += uint64(len(data))
			if !answered && path != nil {
				signal, _ := json.Marshal(directSignal{SDP: answer})
				if err = session.send(kindSignal, signal); err != nil {
					return fail(err)
				}
				answered = true
				// Keep the first relay window in flight until ICE is ready.
				// This makes the drain assertion deterministic even on a
				// heavily instrumented race-test build that negotiates slowly.
				select {
				case <-path.opened:
				case <-ctx.Done():
					return fail(ctx.Err())
				}
			}
			if !viaDirect {
				time.Sleep(3 * time.Millisecond)
			}
			if offset-committed >= 1024*1024 || offset == uint64(len(want)) {
				if (offset-initial)%(1024*1024) != 0 && offset != uint64(len(want)) {
					return fail(errors.New("unexpected ACK boundary"))
				}
				if err = session.send(kindAck, encodeCounts(resumeCounts(offset), offset)); err != nil {
					return fail(err)
				}
				committed = offset
			}
		case kindEnd:
			if viaDirect || offset != uint64(len(want)) || committed != offset || !bytes.Equal(actual, want) {
				return fail(errors.New("final bytes or durable ACKs differ"))
			}
			digest := sha256.Sum256(want)
			if err = resumeVerifyEnd(data, offset, hex.EncodeToString(digest[:])); err != nil {
				return fail(err)
			}
			if err = session.send(kindComplete, data); err != nil {
				return fail(err)
			}
			if err = session.socket.WriteJSON(resumeEvent{Type: "completed", Protocol: resumeProtocol}); err != nil {
				return fail(err)
			}
			return result
		default:
			return fail(fmt.Errorf("unexpected sender record %d", kind))
		}
	}
}

func TestResumeAssemblerAcceptsOnlyItsConfiguredProtocol(t *testing.T) {
	invite := testInvitation()
	sn, _ := resumeRandom()
	rn, _ := resumeRandom()
	seal, _ := newResumeSealer(invite, sn, rn, senderDirection)
	record, err := seal.seal(kindChunk, bytes.Repeat([]byte{0x42}, chunkSize))
	if err != nil {
		t.Fatal(err)
	}
	assembler := recordAssembler{version: resumeVersion}
	var complete [][]byte
	for start := 0; start < len(record); start += directPieceSize {
		frames, err := assembler.push(record[start:min(start+directPieceSize, len(record))])
		if err != nil {
			t.Fatal(err)
		}
		complete = append(complete, frames...)
	}
	if len(complete) != 1 || !bytes.Equal(complete[0], record) {
		t.Fatal("v2 record fragments did not reconstruct exactly")
	}
	if _, err := (&recordAssembler{}).push(record); err == nil {
		t.Fatal("v1 assembler accepted v2 record")
	}
	legacy, _ := newSealer(invite, senderDirection)
	v1, _ := legacy.sealInto(nil, kindChunk, []byte("v1"))
	if _, err := (&recordAssembler{version: resumeVersion}).push(v1); err == nil {
		t.Fatal("v2 assembler accepted v1 record")
	}
}

func TestResumeDirectEligibilityAndOptionalNegotiationFailure(t *testing.T) {
	left, _, _ := relayPair(t)
	session := &resumeSession{socket: left}
	for _, test := range []struct {
		disabled, local bool
		size            uint64
	}{{true, false, directMinBytes}, {false, true, directMinBytes}, {false, false, directMinBytes - 1}} {
		if test.disabled {
			t.Setenv("CD_DIRECT", "0")
		} else {
			t.Setenv("CD_DIRECT", "1")
		}
		session.local = test.local
		path, offer := newResumeDirect(context.Background(), session, test.size)
		if path != nil || offer != nil {
			t.Fatal("ineligible session advertised direct")
		}
	}
	t.Setenv("CD_DIRECT", "1")
	session.local = false
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	direct, offer := newResumeDirect(context.Background(), session, directMinBytes)
	if direct == nil || offer == nil {
		t.Fatal("missing direct offer")
	}
	defer direct.close()
	direct.signal([]byte(`{"sdp":"` + strings.Repeat("x", maxSDPBytes+1) + `"}`))
	if !direct.closing.Load() {
		t.Fatal("oversized SDP was accepted")
	}
	// Optional negotiation failure leaves the still-authenticated relay usable.
	if err := session.socket.WriteMessage(websocket.BinaryMessage, []byte("relay remains live")); err != nil {
		t.Fatal(err)
	}
}

func TestResumeDirectFailureAfterUseInterruptsSession(t *testing.T) {
	left, right, _ := relayPair(t)
	t.Setenv("CD_DIRECT", "1")
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session := &resumeSession{socket: left}
	direct, offer := newResumeDirect(ctx, session, directMinBytes)
	if direct == nil || offer == nil {
		t.Fatal("missing direct path")
	}
	defer direct.close()
	receiver, err := newDirectPath(func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.close()
	answer, err := receiver.answerOffer(offer.SDP, nil)
	if err != nil {
		t.Fatal(err)
	}
	signal, _ := json.Marshal(directSignal{SDP: answer})
	direct.signal(signal)
	select {
	case <-direct.path.opened:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	direct.used.Store(true)
	// Model an ICE/data-channel failure rather than ordinary transfer cleanup.
	direct.path.close()
	left.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err = left.ReadMessage(); err == nil {
		t.Fatal("used direct failure left relay session running")
	}
	// The remote socket is closed by the test relay lifecycle; no further
	// transfer records can be accepted under the interrupted session keys.
	right.Close()
}

func TestResumeDirectBoundsPreAnswerCandidates(t *testing.T) {
	left, _, _ := relayPair(t)
	session := &resumeSession{socket: left}
	t.Setenv("CD_DIRECT", "1")
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	defer func() { directICEServers = saved }()
	direct, offer := newResumeDirect(context.Background(), session, directMinBytes)
	if direct == nil || offer == nil {
		t.Fatal("missing direct path")
	}
	defer direct.close()
	candidate := webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 2130706431 192.168.1.2 12345 typ host"}
	signal, _ := json.Marshal(directSignal{Candidate: &candidate})
	for range maxRemoteCandidates {
		direct.signal(signal)
	}
	if direct.closing.Load() || len(direct.pending) != maxRemoteCandidates {
		t.Fatal("bounded pre-answer candidates were not retained")
	}
	direct.signal(signal)
	if !direct.closing.Load() || len(direct.pending) > maxRemoteCandidates {
		t.Fatal("candidate limit was not enforced")
	}
}
