package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// The same-network lane: when both ends are cdx, a TCP connection between
// them carries the records instead of the WebRTC data channel. The kernel
// moves bulk TCP data with far less work per byte than SCTP over DTLS in
// userspace, whose ~1.2 KB packets cap a data channel well below a fast
// local link.
//
// The sender offers its private addresses on an ephemeral listening port.
// When both clients advertise reverse support, the receiver instead returns
// its own listener in the encrypted acceptance, and the sender connects. This
// direction is chosen before dialing, so both listeners cannot win. Private
// addresses are exchanged only inside encrypted records. Before any record
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

// Diagnostics contain fixed stage names and network errors, never the
// invitation, transfer key, authentication nonces, or proofs.
func lanDebug(stage string, err error) {
	if os.Getenv("CD_LAN_DEBUG") != "1" {
		return
	}
	event := struct {
		Event string `json:"event"`
		Stage string `json:"stage"`
		Error string `json:"error,omitempty"`
	}{Event: "lan-debug", Stage: stage}
	if err != nil {
		event.Error = err.Error()
	}
	_ = json.NewEncoder(os.Stderr).Encode(event)
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
func validateLANOffer(offer *lanOffer) error {
	if offer == nil || offer.Port < 1024 || offer.Port > 65535 || len(offer.Hosts) == 0 || len(offer.Hosts) > lanMaxHosts {
		return errors.New("invalid same-network offer")
	}
	for _, host := range offer.Hosts {
		if !lanAddress(net.ParseIP(host)) {
			return errors.New("invalid same-network offer")
		}
	}
	return nil
}

func lanTargets(offer *lanOffer) ([]string, error) {
	if err := validateLANOffer(offer); err != nil {
		return nil, err
	}
	targets := make([]string, 0, len(offer.Hosts))
	for _, host := range offer.Hosts {
		ip := net.ParseIP(host)
		if lanReachableAddress(ip) {
			targets = append(targets, net.JoinHostPort(ip.String(), strconv.Itoa(offer.Port)))
		}
	}
	if len(targets) == 0 {
		return nil, errors.New("no offered address shares a local network")
	}
	return targets, nil
}

// Only dial networks attached to this receiver, never arbitrary private targets.
func lanReachableAddress(ip net.IP) bool {
	addresses, err := lanInterfaceAddrs()
	if err != nil {
		return false
	}
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if !ok {
			continue
		}
		if ip.IsLoopback() {
			if lanAcceptsLoopback && ip.Equal(network.IP) {
				return true
			}
			continue
		}
		if lanAddress(network.IP) && network.Contains(ip) {
			return true
		}
	}
	return false
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
func (lane *lanListener) serve(adopt func(net.Conn, func() error) bool) {
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
			confirm, err := lanAuthenticate(connection, lane.key, lane.id)
			if err != nil {
				lanDebug("sender-authentication-failed", err)
				_ = connection.Close()
				return
			}
			if !won.CompareAndSwap(false, true) {
				lanDebug("sender-other-connection-selected", nil)
				_ = connection.Close()
				return
			}
			lane.close()
			if !adopt(connection, confirm) {
				lanDebug("sender-adoption-rejected", nil)
				_ = connection.Close()
			} else {
				lanDebug("sender-adopted", nil)
			}
		}()
	}
}

// lanAnswer authenticates the listening end. The listener may be the file
// sender or receiver; proof roles bind listener and initiator, while record
// encryption retains the logical file sender/receiver directions.
func lanAnswer(connection net.Conn, key []byte, id [16]byte) error {
	confirm, err := lanAuthenticate(connection, key, id)
	if err != nil {
		return err
	}
	return confirm()
}

func lanAuthenticate(connection net.Conn, key []byte, id [16]byte) (func() error, error) {
	if err := connection.SetDeadline(time.Now().Add(lanHandshakeWait)); err != nil {
		return nil, err
	}
	hello := make([]byte, len(lanMagic)+lanNonceBytes)
	if _, err := io.ReadFull(connection, hello); err != nil {
		return nil, err
	}
	if !bytes.Equal(hello[:len(lanMagic)], lanMagic) {
		return nil, errors.New("not a CD connection")
	}
	receiverNonce := hello[len(lanMagic):]
	senderNonce := make([]byte, lanNonceBytes)
	if _, err := rand.Read(senderNonce); err != nil {
		return nil, err
	}
	reply := append(senderNonce, lanProof(key, "listener", id, receiverNonce, senderNonce)...)
	if _, err := connection.Write(reply); err != nil {
		return nil, err
	}
	proof := make([]byte, sha256.Size)
	if _, err := io.ReadFull(connection, proof); err != nil {
		return nil, err
	}
	if !hmac.Equal(proof, lanProof(key, "initiator", id, receiverNonce, senderNonce)) {
		return nil, errors.New("peer does not hold the transfer key")
	}
	return func() error {
		if _, err := connection.Write(lanProof(key, "selected", id, receiverNonce, senderNonce)); err != nil {
			return err
		}
		return connection.SetDeadline(time.Time{})
	}, nil
}

// lanJoin authenticates the initiating end and waits for selection.
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
	if !hmac.Equal(reply[lanNonceBytes:], lanProof(key, "listener", id, receiverNonce, senderNonce)) {
		return errors.New("peer does not hold the transfer key")
	}
	if _, err := connection.Write(lanProof(key, "initiator", id, receiverNonce, senderNonce)); err != nil {
		return err
	}
	selected := make([]byte, sha256.Size)
	if _, err := io.ReadFull(connection, selected); err != nil {
		return err
	}
	if !hmac.Equal(selected, lanProof(key, "selected", id, receiverNonce, senderNonce)) {
		return errors.New("sender did not select this connection")
	}
	return connection.SetDeadline(time.Time{})
}

// dialLAN races authenticated connections, so an unrelated or stalled service
// on one offered address cannot suppress another working address.
func dialLAN(ctx context.Context, offer *lanOffer, value invitation) (net.Conn, error) {
	targets, err := lanTargets(offer)
	if err != nil {
		lanDebug("receiver-target-validation-failed", err)
		return nil, err
	}
	key, err := lanKey(value)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, lanDialWait+lanHandshakeWait)
	defer cancel()
	results := make(chan net.Conn, len(targets))
	for _, target := range targets {
		go func() {
			connection, err := (&net.Dialer{Timeout: lanDialWait}).DialContext(dialCtx, "tcp", target)
			if err != nil {
				lanDebug("receiver-tcp-connect-failed", err)
				results <- nil
				return
			}
			stop := context.AfterFunc(dialCtx, func() { _ = connection.Close() })
			err = lanJoin(connection, key, value.id)
			detached := stop()
			if err != nil || !detached {
				lanDebug("receiver-authentication-failed", err)
				_ = connection.Close()
				results <- nil
				return
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
		} else {
			_ = connection.Close()
		}
	}
	if kept == nil {
		return nil, errors.New("no offered address authenticated")
	}
	lanDebug("receiver-authenticated", nil)
	return kept, nil
}

// reverseLAN serializes receiver-listener adoption with forward fallback.
// Exactly one of those decisions can succeed, even for an authentication
// already in progress when the fallback timer fires.
type reverseLAN struct {
	lane    *lanListener
	value   invitation
	ready   chan struct{}
	mutex   sync.Mutex
	stopped bool
	adopted bool
}

func prepareReverseLAN(link *recordLink, value invitation, offer fileOffer) (*reverseLAN, error) {
	if !offer.ReverseLAN || !directEnabled() || !lanEnabled() {
		return nil, nil
	}
	// The sender's offer must demonstrate a shared attached network. Otherwise
	// keep the existing WebRTC startup instead of adding a reverse-LAN timeout
	// to internet transfers.
	if offer.LAN == nil {
		return nil, nil
	}
	if _, err := lanTargets(offer.LAN); err != nil {
		lanDebug("reverse-receiver-unshared-network", err)
		return nil, nil
	}
	lane, err := listenLAN(value)
	if err != nil {
		return nil, err
	}
	reverse := &reverseLAN{lane: lane, value: value, ready: make(chan struct{})}
	go lane.serve(func(connection net.Conn, confirm func() error) bool {
		reverse.mutex.Lock()
		defer reverse.mutex.Unlock()
		if reverse.stopped {
			return false
		}
		if !link.adoptStreamConfirmed(connection, confirm) {
			return false
		}
		reverse.adopted = true
		reverse.stopped = true
		close(reverse.ready)
		lanDebug("reverse-receiver-adopted", nil)
		return true
	})
	return reverse, nil
}

func (reverse *reverseLAN) close() bool {
	reverse.mutex.Lock()
	defer reverse.mutex.Unlock()
	reverse.stopped = true
	reverse.lane.close()
	return reverse.adopted
}

func (reverse *reverseLAN) await(ctx context.Context, link *recordLink, offer fileOffer) {
	timer := time.NewTimer(lanDialWait + lanHandshakeWait)
	defer timer.Stop()
	select {
	case <-reverse.ready:
		return
	case <-ctx.Done():
		reverse.close()
		return
	case <-link.stop:
		reverse.close()
		return
	case <-timer.C:
	}
	if reverse.close() || ctx.Err() != nil {
		return
	}
	// close has excluded pending reverse adoptions before another direction
	// can win. Try the original sender listener for the opposite firewall
	// orientation, then use the existing WebRTC fallback.
	lanDebug("reverse-receiver-forward-fallback", nil)
	openDirectPath(ctx, link, reverse.value, offer)
}

func dialReverseLAN(ctx context.Context, link *recordLink, value invitation, offer *lanOffer) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-link.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	stream, err := dialLAN(ctx, offer, value)
	if err != nil {
		lanDebug("reverse-sender-connect-failed", err)
		return
	}
	if !link.adoptStream(stream) {
		lanDebug("reverse-sender-adoption-rejected", nil)
		_ = stream.Close()
		return
	}
	lanDebug("reverse-sender-adopted", nil)
}
