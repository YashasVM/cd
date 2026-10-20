package devices

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Message struct {
	Version     int    `json:"version"`
	Type        string `json:"type"`
	MessageID   string `json:"messageId"`
	ExpiresAt   int64  `json:"expiresAt"`
	Name        string `json:"name,omitempty"`
	TransferID  string `json:"transferId,omitempty"`
	URL         string `json:"url,omitempty"`
	LocalURL    string `json:"localUrl,omitempty"`
	Filename    string `json:"filename,omitempty"`
	Size        string `json:"size,omitempty"`
	WholeSHA256 string `json:"wholeSha256,omitempty"`
}

// Codec may be shared across local and relay peers so replay checks cover both.
type Codec struct {
	pairID, role string
	seal, open   cipher.AEAD
	mu           sync.Mutex
	seen         map[string]int64
}

func NewCodec(p Pair, sendRole string) (*Codec, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if !validRole(sendRole) {
		return nil, errors.New("invalid role")
	}
	other := Sender
	if sendRole == Sender {
		other = Receiver
	}
	makeAEAD := func(role string) (cipher.AEAD, error) {
		key, err := p.derive(role + " messages")
		if err != nil {
			return nil, err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		return cipher.NewGCM(block)
	}
	seal, err := makeAEAD(sendRole)
	if err != nil {
		return nil, err
	}
	open, err := makeAEAD(other)
	if err != nil {
		return nil, err
	}
	return &Codec{pairID: p.PairID, role: sendRole, seal: seal, open: open, seen: map[string]int64{}}, nil
}
func (m Message) validate(role string, now time.Time) error {
	if m.Version != 1 || m.ExpiresAt <= now.UnixMilli() || m.ExpiresAt > now.Add(MaxLifetime+MaxClockSkew).UnixMilli() {
		return errors.New("invalid message version or expiry")
	}
	if _, err := decode(m.MessageID, 16); err != nil {
		return err
	}
	switch m.Type {
	case "paired":
		if role != Receiver || m.Name == "" || len(m.Name) > 128 || strings.ContainsAny(m.Name, "\x00\r\n") {
			return errors.New("invalid paired message")
		}
	case "offer":
		if role != Sender || m.Filename == "" || len(m.Filename) > 1024 || strings.ContainsAny(m.Filename, "/\\\x00") || m.Filename == "." || m.Filename == ".." {
			return errors.New("invalid offer")
		}
		size, err := strconv.ParseUint(m.Size, 10, 53)
		if err != nil || strconv.FormatUint(size, 10) != m.Size {
			return errors.New("invalid file size")
		}
		hash, err := hex.DecodeString(m.WholeSHA256)
		if err != nil || len(hash) != 32 || strings.ToLower(m.WholeSHA256) != m.WholeSHA256 {
			return errors.New("invalid file digest")
		}
		if len(m.URL) == 0 || len(m.URL) > 4096 {
			return errors.New("invalid invitation")
		}
		if m.LocalURL != "" {
			if err := ValidateEndpoint(m.LocalURL, true); err != nil {
				return err
			}
		}
		fallthrough
	case "received", "paused":
		if m.Type != "offer" && role != Receiver {
			return errors.New("invalid receiver message")
		}
		if _, err := decode(m.TransferID, 16); err != nil {
			return err
		}
	default:
		return errors.New("unknown device message type")
	}
	return nil
}
func (c *Codec) Seal(m Message) ([]byte, error) { return c.SealAt(m, time.Now()) }
func (c *Codec) SealAt(m Message, now time.Time) ([]byte, error) {
	if m.Version == 0 {
		m.Version = 1
	}
	if m.MessageID == "" {
		id, err := randomID(16)
		if err != nil {
			return nil, err
		}
		m.MessageID = id
	}
	if m.ExpiresAt == 0 {
		m.ExpiresAt = now.Add(MaxLifetime).UnixMilli()
	}
	if err := m.validate(c.role, now); err != nil {
		return nil, err
	}
	plain, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	if len(plain)+28 > MaxFrame {
		return nil, errors.New("control message exceeds limit")
	}
	nonce := make([]byte, 12)
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return c.seal.Seal(nonce, nonce, plain, []byte(Protocol+" "+c.role+" "+c.pairID)), nil
}
func (c *Codec) Open(frame []byte) (Message, error) { return c.OpenAt(frame, time.Now()) }
func (c *Codec) OpenAt(frame []byte, now time.Time) (Message, error) {
	if len(frame) < 28 || len(frame) > MaxFrame {
		return Message{}, errors.New("invalid control frame size")
	}
	other := Sender
	if c.role == Sender {
		other = Receiver
	}
	plain, err := c.open.Open(nil, frame[:12], frame[12:], []byte(Protocol+" "+other+" "+c.pairID))
	if err != nil {
		return Message{}, errors.New("control authentication failed")
	}
	var m Message
	if err = json.Unmarshal(plain, &m); err != nil {
		return Message{}, err
	}
	if err = m.validate(other, now); err != nil {
		return Message{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, expiry := range c.seen {
		if expiry <= now.UnixMilli() {
			delete(c.seen, id)
		}
	}
	if _, exists := c.seen[m.MessageID]; exists {
		return Message{}, errors.New("replayed control message")
	}
	if len(c.seen) >= 8192 {
		return Message{}, errors.New("control replay cache full")
	}
	c.seen[m.MessageID] = m.ExpiresAt
	return m, nil
}
