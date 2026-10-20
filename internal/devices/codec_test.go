package devices

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testPair(t *testing.T) Pair {
	t.Helper()
	p, err := NewPair("laptop", "wss://cd.yash0.in", nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func codecs(t *testing.T, p Pair) (*Codec, *Codec) {
	t.Helper()
	s, e := NewCodec(p, Sender)
	if e != nil {
		t.Fatal(e)
	}
	r, e := NewCodec(p, Receiver)
	if e != nil {
		t.Fatal(e)
	}
	return s, r
}
func testOffer(t *testing.T) Message {
	t.Helper()
	id, err := randomID(16)
	if err != nil {
		t.Fatal(err)
	}
	return Message{Type: "offer", TransferID: id, URL: "https://cd.yash0.in/#v2:private-invitation", Filename: "video.mp4", Size: "1234", WholeSHA256: strings.Repeat("a", 64)}
}
func TestPairQRRoundTripAndExpiry(t *testing.T) {
	now := time.Now()
	p, err := NewPair("laptop", "wss://cd.yash0.in", []string{"ws://192.168.1.3:3210"}, now)
	if err != nil {
		t.Fatal(err)
	}
	qr, err := p.QR()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseQR(qr, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Secret != p.Secret || got.PairID != p.PairID || got.LocalURLs[0] != "ws://192.168.1.3:3210/ws/devices/v1/"+p.PairID {
		t.Fatalf("wrong QR: %+v", got)
	}
	if _, err = ParseQR(qr, now.Add(MaxLifetime)); err == nil {
		t.Fatal("expired pairing accepted")
	}
	if _, err = ParseQR(qr, now.Add(-time.Minute)); err == nil {
		t.Fatal("overlong pairing lifetime accepted")
	}
}
func TestEndpointSecurity(t *testing.T) {
	for _, endpoint := range []string{"ws://example.com/x", "ws://8.8.8.8/x", "http://192.168.1.2/x", "wss://a:b@example.com/x", "ws://127.0.0.1/x", "ws://0.0.0.0/x"} {
		if ValidateEndpoint(endpoint, false) == nil {
			t.Errorf("unsafe endpoint %s accepted", endpoint)
		}
	}
	for _, endpoint := range []string{"wss://example.com/x", "ws://192.168.1.3:1234/x", "ws://[fe80::1]:1234/x"} {
		if err := ValidateEndpoint(endpoint, false); err != nil {
			t.Errorf("%s: %v", endpoint, err)
		}
	}
	if ValidateEndpoint("ws://127.0.0.1/x", true) != nil {
		t.Fatal("explicit loopback rejected")
	}
}
func TestMessageRoundTripTamperReplayAndDirection(t *testing.T) {
	p := testPair(t)
	s, r := codecs(t, p)
	m := testOffer(t)
	frame, err := s.Seal(m)
	if err != nil {
		t.Fatal(err)
	}
	frame2, err := s.Seal(m)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(frame[:12], frame2[:12]) {
		t.Fatal("reused random nonce")
	}
	modified := append([]byte(nil), frame...)
	modified[len(modified)-1] ^= 1
	if _, err = r.Open(modified); err == nil {
		t.Fatal("tampered frame accepted")
	}
	got, err := r.Open(frame)
	if err != nil {
		t.Fatal(err)
	}
	if got.Filename != "video.mp4" || got.Size != "1234" {
		t.Fatalf("wrong decoded message: %+v", got)
	}
	if _, err = r.Open(frame); err == nil {
		t.Fatal("replayed frame accepted")
	}
	if _, err = s.Open(frame); err == nil {
		t.Fatal("reflected sender frame accepted")
	}
	other := testPair(t)
	_, wrong := codecs(t, other)
	if _, err = wrong.Open(frame2); err == nil {
		t.Fatal("wrong pair accepted")
	}
	if _, err = s.Seal(Message{Type: "paired", Name: "phone"}); err == nil {
		t.Fatal("sender emitted receiver message")
	}
	if _, err = r.Seal(m); err == nil {
		t.Fatal("receiver emitted offer")
	}
	reply, err := r.Seal(Message{Type: "paired", Name: "phone"})
	if err != nil {
		t.Fatal(err)
	}
	if got, err = s.Open(reply); err != nil || got.Name != "phone" {
		t.Fatalf("paired reply: %+v %v", got, err)
	}
}
func TestExpiryRoleAndReplayValidationAfterAuthentication(t *testing.T) {
	p := testPair(t)
	s, r := codecs(t, p)
	now := time.Now()
	id, _ := randomID(16)
	nonce := make([]byte, 12)
	for _, m := range []Message{
		{Version: 1, Type: "paired", Name: "wrong role", MessageID: id, ExpiresAt: now.Add(time.Minute).UnixMilli()},
		{Version: 1, Type: "offer", MessageID: id, ExpiresAt: now.Add(-time.Second).UnixMilli()},
		{Version: 1, Type: "offer", MessageID: id, ExpiresAt: now.Add(6 * time.Minute).UnixMilli()},
	} {
		b, _ := json.Marshal(m)
		frame := s.seal.Seal(append([]byte(nil), nonce...), nonce, b, []byte(Protocol+" sender "+p.PairID))
		if _, err := r.OpenAt(frame, now); err == nil {
			t.Fatalf("invalid authenticated message accepted: %+v", m)
		}
	}
	m := testOffer(t)
	m.ExpiresAt = now.Add(time.Second).UnixMilli()
	frame, err := s.SealAt(m, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.OpenAt(frame, now.Add(time.Second)); err == nil {
		t.Fatal("expired encrypted offer accepted")
	}
}
func TestControlFrameAndFieldsBounded(t *testing.T) {
	s, r := codecs(t, testPair(t))
	if _, err := r.Open(make([]byte, MaxFrame+1)); err == nil {
		t.Fatal("oversized frame accepted")
	}
	for _, mutate := range []func(*Message){func(m *Message) { m.Size = "01" }, func(m *Message) { m.Size = "9007199254740992" }, func(m *Message) { m.Filename = "../secret" }, func(m *Message) { m.LocalURL = "ws://8.8.8.8/x" }, func(m *Message) { m.TransferID = "name-only" }, func(m *Message) { m.WholeSHA256 = strings.Repeat("A", 64) }} {
		m := testOffer(t)
		mutate(&m)
		if _, err := s.Seal(m); err == nil {
			t.Fatalf("invalid offer accepted: %+v", m)
		}
	}
}
func TestDerivationGolden(t *testing.T) {
	p := testPair(t)
	p.PairID = base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	p.Secret = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	key, err := p.derive("sender messages")
	if err != nil {
		t.Fatal(err)
	}
	// Independently generated from the RFC 5869 extract/expand algorithm.
	if got := hex.EncodeToString(key); got != "49d8abcd5471f069c51f151deaa4214ad20d8930fcde06c7a3517921e4824976" {
		t.Fatalf("derived key: %s", got)
	}
}

func TestPairAndEncryptedMessageUpperClockSkewBound(t *testing.T) {
	now := time.UnixMilli(1792330000000)
	for _, test := range []struct {
		name     string
		lifetime time.Duration
		accepted bool
	}{
		{"sender one second ahead", MaxLifetime + time.Second, true},
		{"sender at skew limit", MaxLifetime + MaxClockSkew, true},
		{"sender beyond skew limit", MaxLifetime + MaxClockSkew + time.Millisecond, false},
		{"expired now", 0, false},
		{"already expired", -time.Millisecond, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Generate on the sender's clock, which gives this offer exactly five
			// minutes. Only the receiving clock determines the acceptance bound.
			senderNow := now.Add(test.lifetime - MaxLifetime)
			pair, err := NewPair("laptop", "wss://cd.yash0.in", nil, senderNow)
			if err != nil {
				t.Fatal(err)
			}
			qr, err := pair.QR()
			if err != nil {
				t.Fatal(err)
			}
			_, err = ParseQR(qr, now)
			if (err == nil) != test.accepted {
				t.Fatalf("QR acceptance %v, expected %v: %v", err == nil, test.accepted, err)
			}
			sender, receiver := codecs(t, pair)
			offer := testOffer(t)
			frame, err := sender.SealAt(offer, senderNow)
			if err != nil {
				t.Fatal(err)
			}
			_, err = receiver.OpenAt(frame, now)
			if (err == nil) != test.accepted {
				t.Fatalf("message acceptance %v, expected %v: %v", err == nil, test.accepted, err)
			}
		})
	}
}

func TestSharedAndroidDeviceV1Fixture(t *testing.T) {
	var fixture struct {
		Protocol      string  `json:"protocol"`
		Pair          Pair    `json:"pair"`
		Now           int64   `json:"now"`
		SenderToken   string  `json:"senderToken"`
		ReceiverToken string  `json:"receiverToken"`
		SenderKey     string  `json:"senderKey"`
		ReceiverKey   string  `json:"receiverKey"`
		Offer         Message `json:"offer"`
		Frame         string  `json:"frame"`
	}
	data, err := os.ReadFile("../../fixtures/device-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Protocol != Protocol {
		t.Fatalf("fixture protocol %q", fixture.Protocol)
	}
	for _, test := range []struct{ info, expected string }{
		{"sender join", fixture.SenderToken}, {"receiver join", fixture.ReceiverToken},
		{"sender messages", fixture.SenderKey}, {"receiver messages", fixture.ReceiverKey},
	} {
		key, err := fixture.Pair.derive(test.info)
		if err != nil {
			t.Fatal(err)
		}
		if base64.RawURLEncoding.EncodeToString(key) != test.expected {
			t.Fatalf("fixture derivation mismatch for %s", test.info)
		}
	}
	codec, err := NewCodec(fixture.Pair, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := base64.RawURLEncoding.DecodeString(fixture.Frame)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := codec.OpenAt(frame, time.UnixMilli(fixture.Now))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(offer, fixture.Offer) {
		t.Fatalf("fixture offer mismatch: got %+v expected %+v", offer, fixture.Offer)
	}
}

func TestLocalJoinUsesSeparateChallengeBoundDerivation(t *testing.T) {
	var fixture struct {
		Pair Pair `json:"pair"`
	}
	data, err := os.ReadFile("../../fixtures/device-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	// Values come from an independent RFC5869/HMAC implementation.
	nonce := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	for _, test := range []struct{ role, expected string }{
		{Sender, "A7JzUVkNOq6RobQXajbxAVAZ9QpvAt2OSMpCVeB9UUY"},
		{Receiver, "x9-b8gL9XIAlFCt7ZJNPp9ESaGxBG9aXw286OoZaFzw"},
	} {
		join, err := fixture.Pair.LocalJoin(test.role, nonce)
		if err != nil {
			t.Fatal(err)
		}
		if join.LocalProof != test.expected {
			t.Fatalf("local proof derivation mismatch for %s", test.role)
		}
	}
	if _, err = fixture.Pair.LocalJoin("attacker", nonce); err == nil {
		t.Fatal("invalid local role accepted")
	}
	if _, err = fixture.Pair.LocalJoin(Receiver, "bad challenge"); err == nil {
		t.Fatal("invalid local challenge accepted")
	}
}
