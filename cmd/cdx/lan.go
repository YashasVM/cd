package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

// The same-network lane: when both ends are cdx, a TCP connection between
// them carries the records instead of the WebRTC data channel. The kernel
// moves bulk TCP data with far less work per byte than SCTP over DTLS in
// userspace, whose ~1.2 KB packets cap a data channel well below a fast
// local link.
//
// The sender listens on an ephemeral port and lists its private addresses in
// the encrypted file offer, so only holders of the transfer key learn them.
// The receiver connects to the first address that answers. Before any record
// moves, each end sends a fresh nonce and proves it holds the transfer key
// with an HMAC over both nonces, keyed by a secret derived from the transfer
// key; the roles are bound into the HMAC so neither proof can be reflected.
// Records keep their end-to-end encryption on the connection. Browsers ignore
// the offer field, and a lane that does not connect leaves the receiver to
// answer the WebRTC offer as before.

const (
	// lanDialWait bounds connecting to the offered addresses. Same-network
	// connections complete in milliseconds.
	lanDialWait = time.Second
	// lanHandshakeWait bounds the key proof once connected.
	lanHandshakeWait = 2 * time.Second
	lanMaxHosts      = 8
	// lanMaxPending bounds connections in their handshake at once.
	lanMaxPending = 8
	lanNonceBytes = 32
	lanReadBuffer = 1024 * 1024
)

var lanMagic = []byte("CDL1")

// lanOffer is the optional `lan` member of the encrypted file offer.
type lanOffer struct {
	Port  int      `json:"port"`
	Hosts []string `json:"hosts"`
}

// lanEnabled lets tests and benchmarks turn the lane off (CD_LAN=0).
func lanEnabled() bool {
	return os.Getenv("CD_LAN") != "0"
}

// lanAcceptsLoopback lets tests run the lane on 127.0.0.1.
var lanAcceptsLoopback = false

// lanAddress reports whether the lane offers and dials ip: private (RFC 1918,
// unique local) and carrier-grade NAT space, which VPN overlays such as
// Tailscale use.
func lanAddress(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsPrivate() || lanAcceptsLoopback && ip.IsLoopback() {
		return true
	}
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1]&0xc0 == 64
}

// lanInterfaceAddrs is a variable so tests can choose the offered addresses.
var lanInterfaceAddrs = net.InterfaceAddrs

func lanHosts() []string {
	addresses, err := lanInterfaceAddrs()
	if err != nil {
		return nil
	}
	var hosts []string
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if ok && lanAddress(network.IP) && len(hosts) < lanMaxHosts {
			hosts = append(hosts, network.IP.String())
		}
	}
	return hosts
}

// lanTargets validates an offer from the sender and returns the addresses
// to dial.
func lanTargets(offer *lanOffer) ([]string, error) {
	if offer.Port < 1 || offer.Port > 65535 || len(offer.Hosts) == 0 || len(offer.Hosts) > lanMaxHosts {
		return nil, errors.New("invalid same-network offer")
	}
	targets := make([]string, 0, len(offer.Hosts))
	for _, host := range offer.Hosts {
		ip := net.ParseIP(host)
		if !lanAddress(ip) {
			return nil, errors.New("invalid same-network offer")
		}
		targets = append(targets, net.JoinHostPort(ip.String(), strconv.Itoa(offer.Port)))
	}
	return targets, nil
}

func lanKey(value invitation) ([]byte, error) {
	return derive(value.key[:], value.id[:], "cd-transfer-v1 lan handshake")
}

func lanProof(key []byte, role string, id [16]byte, receiverNonce, senderNonce []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(role))
	mac.Write(id[:])
	mac.Write(receiverNonce)
	mac.Write(senderNonce)
	return mac.Sum(nil)
}

type lanListener struct {
	listener net.Listener
	offer    lanOffer
	key      []byte
	id       [16]byte
}

// listenLAN opens the sender's end of the lane on an ephemeral port.
func listenLAN(value invitation) (*lanListener, error) {
	hosts := lanHosts()
	if len(hosts) == 0 {
		return nil, errors.New("no local network address")
	}
	key, err := lanKey(value)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	return &lanListener{listener: listener, offer: lanOffer{Port: port, Hosts: hosts}, key: key, id: value.id}, nil
}

func (lane *lanListener) close() {
	_ = lane.listener.Close()
}

// offered reports whether a connection arrived on an offered address.
func (lane *lanListener) offered(local net.Addr) bool {
	host, _, err := net.SplitHostPort(local.String())
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	for _, offered := range lane.offer.Hosts {
		if ip.Equal(net.ParseIP(offered)) {
			return true
		}
	}
	return false
}

// serve answers connections until the listener closes and hands the first
// one that proves the key to adopt. The lane then stops listening.
func (lane *lanListener) serve(adopt func(net.Conn) bool) {
	var won atomic.Bool
	pending := make(chan struct{}, lanMaxPending)
	for {
		connection, err := lane.listener.Accept()
		if err != nil {
			return
		}
		if won.Load() || !lane.offered(connection.LocalAddr()) {
			_ = connection.Close()
			continue
		}
		select {
		case pending <- struct{}{}:
		default:
			_ = connection.Close()
			continue
		}
		go func() {
			defer func() { <-pending }()
			if lanAnswer(connection, lane.key, lane.id) != nil || !won.CompareAndSwap(false, true) {
				_ = connection.Close()
				return
			}
			lane.close()
			if !adopt(connection) {
				_ = connection.Close()
			}
		}()
	}
}

// lanAnswer is the sender's side of the key proof.
func lanAnswer(connection net.Conn, key []byte, id [16]byte) error {
	if err := connection.SetDeadline(time.Now().Add(lanHandshakeWait)); err != nil {
		return err
	}
	hello := make([]byte, len(lanMagic)+lanNonceBytes)
	if _, err := io.ReadFull(connection, hello); err != nil {
		return err
	}
	if !bytes.Equal(hello[:len(lanMagic)], lanMagic) {
		return errors.New("not a CD connection")
	}
	receiverNonce := hello[len(lanMagic):]
	senderNonce := make([]byte, lanNonceBytes)
	if _, err := rand.Read(senderNonce); err != nil {
		return err
	}
	reply := append(senderNonce, lanProof(key, "sender", id, receiverNonce, senderNonce)...)
	if _, err := connection.Write(reply); err != nil {
		return err
	}
	proof := make([]byte, sha256.Size)
	if _, err := io.ReadFull(connection, proof); err != nil {
		return err
	}
	if !hmac.Equal(proof, lanProof(key, "receiver", id, receiverNonce, senderNonce)) {
		return errors.New("peer does not hold the transfer key")
	}
	return connection.SetDeadline(time.Time{})
}

// lanJoin is the receiver's side of the key proof.
func lanJoin(connection net.Conn, key []byte, id [16]byte) error {
	if err := connection.SetDeadline(time.Now().Add(lanHandshakeWait)); err != nil {
		return err
	}
	receiverNonce := make([]byte, lanNonceBytes)
	if _, err := rand.Read(receiverNonce); err != nil {
		return err
	}
	if _, err := connection.Write(append(bytes.Clone(lanMagic), receiverNonce...)); err != nil {
		return err
	}
	reply := make([]byte, lanNonceBytes+sha256.Size)
	if _, err := io.ReadFull(connection, reply); err != nil {
		return err
	}
	senderNonce := reply[:lanNonceBytes]
	if !hmac.Equal(reply[lanNonceBytes:], lanProof(key, "sender", id, receiverNonce, senderNonce)) {
		return errors.New("peer does not hold the transfer key")
	}
	if _, err := connection.Write(lanProof(key, "receiver", id, receiverNonce, senderNonce)); err != nil {
		return err
	}
	return connection.SetDeadline(time.Time{})
}

// dialLAN connects to the first offered address that answers, closes the
// others before any handshake, and proves the key on the one it kept.
func dialLAN(ctx context.Context, offer *lanOffer, value invitation) (net.Conn, error) {
	targets, err := lanTargets(offer)
	if err != nil {
		return nil, err
	}
	key, err := lanKey(value)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, lanDialWait)
	defer cancel()
	results := make(chan net.Conn, len(targets))
	var dialer net.Dialer
	for _, target := range targets {
		go func() {
			connection, err := dialer.DialContext(dialCtx, "tcp", target)
			if err != nil {
				connection = nil
			}
			results <- connection
		}()
	}
	var kept net.Conn
	for range targets {
		connection := <-results
		if connection == nil {
			continue
		}
		if kept == nil {
			kept = connection
			cancel()
			continue
		}
		_ = connection.Close()
	}
	if kept == nil {
		return nil, errors.New("no offered address answered")
	}
	if err := lanJoin(kept, key, value.id); err != nil {
		_ = kept.Close()
		return nil, err
	}
	return kept, nil
}
