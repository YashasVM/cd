package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// loopbackLane offers 127.0.0.1 so the lane runs inside the test.
func loopbackLane(t *testing.T) {
	t.Helper()
	savedAddrs, savedLoopback := lanInterfaceAddrs, lanAcceptsLoopback
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.IPv4(127, 0, 0, 1), Mask: net.CIDRMask(8, 32)}}, nil
	}
	lanAcceptsLoopback = true
	t.Cleanup(func() { lanInterfaceAddrs, lanAcceptsLoopback = savedAddrs, savedLoopback })
}

func otherInvitation() invitation {
	value := testInvitation()
	value.key[0] ^= 0xff
	return value
}

func TestLANAddressesArePrivateOnly(t *testing.T) {
	for host, want := range map[string]bool{
		"192.168.1.5": true, "10.0.0.2": true, "172.16.4.1": true, "fd7a:115c:a1e0::1": true, "100.101.102.103": true,
		"8.8.8.8": false, "127.0.0.1": false, "169.254.1.1": false, "fe80::1": false, "2001:db8::1": false, "100.128.0.1": false,
	} {
		if got := lanAddress(net.ParseIP(host)); got != want {
			t.Errorf("lanAddress(%s) = %v, want %v", host, got, want)
		}
	}
}

func TestLANTargetsRejectInvalidOffers(t *testing.T) {
	saved := lanInterfaceAddrs
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		_, v4, _ := net.ParseCIDR("192.168.1.0/24")
		_, v6, _ := net.ParseCIDR("fd00::/64")
		return []net.Addr{v4, v6}, nil
	}
	t.Cleanup(func() { lanInterfaceAddrs = saved })
	for name, offer := range map[string]lanOffer{
		"unrelated private": {Port: 4000, Hosts: []string{"10.45.0.3"}},
		"privileged port":   {Port: 22, Hosts: []string{"192.168.1.5"}},
		"metadata":          {Port: 4000, Hosts: []string{"169.254.169.254"}},
		"loopback":          {Port: 4000, Hosts: []string{"127.0.0.1"}},
		"unrelated overlay": {Port: 4000, Hosts: []string{"100.101.102.103"}},
		"no port":           {Hosts: []string{"192.168.1.5"}},
		"high port":         {Port: 70000, Hosts: []string{"192.168.1.5"}},
		"no hosts":          {Port: 4000},
		"public host":       {Port: 4000, Hosts: []string{"8.8.8.8"}},
		"hostname":          {Port: 4000, Hosts: []string{"printer.local"}},
		"too many":          {Port: 4000, Hosts: []string{"10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7", "10.0.0.8", "10.0.0.9"}},
	} {
		if _, err := lanTargets(&offer); err == nil {
			t.Errorf("%s: offer accepted", name)
		}
	}
	targets, err := lanTargets(&lanOffer{Port: 4000, Hosts: []string{"192.168.1.5", "fd00::7"}})
	if err != nil || len(targets) != 2 || targets[0] != "192.168.1.5:4000" || targets[1] != "[fd00::7]:4000" {
		t.Fatalf("targets = %v %v", targets, err)
	}
}

func TestLANHandshakeRequiresTheTransferKey(t *testing.T) {
	loopbackLane(t)
	lane, err := listenLAN(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer lane.close()
	adopted := make(chan net.Conn, 1)
	go lane.serve(func(stream net.Conn, confirm func() error) bool {
		if confirm() != nil {
			return false
		}
		adopted <- stream
		return true
	})

	if _, err := dialLAN(context.Background(), &lane.offer, otherInvitation()); err == nil {
		t.Fatal("receiver without the key completed the handshake")
	}
	select {
	case <-adopted:
		t.Fatal("sender adopted a connection without the key")
	case <-time.After(100 * time.Millisecond):
	}

	stream, err := dialLAN(context.Background(), &lane.offer, testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	select {
	case peer := <-adopted:
		peer.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("sender did not adopt the authenticated connection")
	}
}

func TestLANReceiverRejectsSenderWithoutTheKey(t *testing.T) {
	loopbackLane(t)
	lane, err := listenLAN(otherInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer lane.close()
	go lane.serve(func(_ net.Conn, confirm func() error) bool { return confirm() == nil })
	if _, err := dialLAN(context.Background(), &lane.offer, testInvitation()); err == nil {
		t.Fatal("receiver trusted a sender without the key")
	}
}

func TestLANDialFailsFastWhenNothingListens(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	loopbackLane(t)
	started := time.Now()
	if _, err := dialLAN(context.Background(), &lanOffer{Port: port, Hosts: []string{"127.0.0.1"}}, testInvitation()); err == nil {
		t.Fatal("dial succeeded with nothing listening")
	}
	if elapsed := time.Since(started); elapsed > lanDialWait+time.Second {
		t.Fatalf("dial took %v", elapsed)
	}
}

// laneLinks connects a linked sender and receiver over the lane.
func laneLinks(t *testing.T) (*recordLink, *recordLink) {
	t.Helper()
	loopbackLane(t)
	sender, receiver, _ := linkedPair(t)
	lane, err := listenLAN(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lane.close)
	adopted := make(chan bool, 1)
	go lane.serve(func(stream net.Conn, confirm func() error) bool {
		ok := sender.adoptStreamConfirmed(stream, confirm)
		adopted <- ok
		return ok
	})
	stream, err := dialLAN(context.Background(), &lane.offer, testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	if !receiver.adoptStream(stream) {
		t.Fatal("receiver did not adopt the lane")
	}
	select {
	case ok := <-adopted:
		if !ok {
			t.Fatal("sender did not adopt the lane")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sender never saw the lane")
	}
	return sender, receiver
}

func TestLANCarriesRecordsBothWaysWithoutTheRelay(t *testing.T) {
	sender, receiver := laneLinks(t)
	if err := sender.send(kindOffer, []byte("ready")); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := receiver.next(context.Background(), 5*time.Second); err != nil || kind != kindOffer {
		t.Fatalf("offer = %v %v", kind, err)
	}
	// Once the lane carries data, losing the relay changes nothing.
	_ = sender.connection.Close()
	for index := range 64 {
		chunk := bytes.Repeat([]byte{byte(index)}, chunkSize)
		if err := sender.sendReleasable(kindChunk, chunk, uint64(index+1)*chunkSize); err != nil {
			t.Fatal(err)
		}
		kind, payload, err := receiver.next(context.Background(), 5*time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(payload, chunk) {
			t.Fatalf("chunk %d = %v (%d bytes) %v", index, kind, len(payload), err)
		}
	}
	if err := receiver.send(kindAck, encodeCounts(64, 64*chunkSize)); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := sender.next(context.Background(), 5*time.Second); err != nil || kind != kindAck {
		t.Fatalf("ack over the lane = %v %v", kind, err)
	}
	if !sender.directUsed.Load() || !receiver.directUsed.Load() {
		t.Fatal("records did not travel over the lane")
	}
}

func TestLANReplacesAnUnopenedWebRTCPathQuietly(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	loopbackLane(t)
	sender, receiver, _ := linkedPair(t)
	webrtcPath, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(webrtcPath)
	lane, err := listenLAN(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer lane.close()
	go lane.serve(sender.adoptStreamConfirmed)
	stream, err := dialLAN(context.Background(), &lane.offer, testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	receiver.adoptStream(stream)
	select {
	case <-webrtcPath.lost:
	case <-time.After(5 * time.Second):
		t.Fatal("the replaced WebRTC path stayed open")
	}
	// The retired path's failure must not end the transfer.
	if err := sender.send(kindOffer, []byte("ready")); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := receiver.next(context.Background(), 5*time.Second); err != nil || kind != kindOffer {
		t.Fatalf("offer = %v %v", kind, err)
	}
	if _, _, _, err := sender.poll(); err != nil {
		t.Fatalf("sender saw the retired path fail: %v", err)
	}
}

func TestLANIsNotAdoptedOnceAnotherDirectPathCarriesData(t *testing.T) {
	sender, _ := laneLinks(t)
	if err := sender.send(kindOffer, []byte("ready")); err != nil {
		t.Fatal(err)
	}
	client, server := net.Pipe()
	defer client.Close()
	if sender.adoptStream(server) {
		t.Fatal("a second stream replaced the path in use")
	}
}

func TestUnreachableLANFallsBackToTheWebRTCAnswer(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	loopbackLane(t)
	sender, receiver, _ := linkedPair(t)
	senderPath, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(senderPath)
	sdp, err := senderPath.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	offer := fileOffer{Direct: &directOffer{SDP: sdp}, LAN: &lanOffer{Port: port, Hosts: []string{"127.0.0.1"}}}
	go openDirectPath(context.Background(), receiver, testInvitation(), offer)
	kind, payload, err := sender.next(context.Background(), 5*time.Second)
	if err != nil || kind != kindSignal || !bytes.Contains(payload, []byte(`"sdp"`)) {
		t.Fatalf("receiver did not answer the WebRTC offer: %v %q %v", kind, payload, err)
	}
}

func TestLANStalledAddressDoesNotSuppressAuthenticatedPeer(t *testing.T) {
	loopbackLane(t)
	saved := lanInterfaceAddrs
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}, &net.IPNet{IP: net.ParseIP("127.0.0.2"), Mask: net.CIDRMask(8, 32)}}, nil
	}
	t.Cleanup(func() { lanInterfaceAddrs = saved })
	stalled, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	port := stalled.Addr().(*net.TCPAddr).Port
	valid, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.2", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer valid.Close()
	key, err := lanKey(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan net.Conn, 2)
	go func() {
		conn, err := stalled.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	go func() {
		conn, err := valid.Accept()
		if err == nil {
			accepted <- conn
			_ = lanAnswer(conn, key, testInvitation().id)
		}
	}()
	started := time.Now()
	conn, err := dialLAN(context.Background(), &lanOffer{Port: port, Hosts: []string{"127.0.0.1", "127.0.0.2"}}, testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if time.Since(started) >= lanHandshakeWait {
		t.Fatal("authenticated peer waited for stalled peer")
	}
	for range 2 {
		select {
		case peer := <-accepted:
			_ = peer.Close()
		case <-time.After(time.Second):
		}
	}
}

func TestLANSkipsUnsharedPrivateNetworks(t *testing.T) {
	saved := lanInterfaceAddrs
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		_, network, _ := net.ParseCIDR("192.168.1.0/24")
		return []net.Addr{network}, nil
	}
	t.Cleanup(func() { lanInterfaceAddrs = saved })
	targets, err := lanTargets(&lanOffer{Port: 4000, Hosts: []string{"100.101.102.103", "192.168.1.5", "10.0.0.8"}})
	if err != nil || len(targets) != 1 || targets[0] != "192.168.1.5:4000" {
		t.Fatalf("targets = %v, %v", targets, err)
	}
	// An invalid address still invalidates the whole offer.
	if _, err := lanTargets(&lanOffer{Port: 4000, Hosts: []string{"192.168.1.5", "8.8.8.8"}}); err == nil {
		t.Fatal("accepted public address mixed with local target")
	}
}

func TestLANConcurrentAuthenticatedAddressesAgreeOnWinner(t *testing.T) {
	loopbackLane(t)
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}, &net.IPNet{IP: net.ParseIP("127.0.0.2"), Mask: net.CIDRMask(8, 32)}}, nil
	}
	for iteration := range 100 {
		lane, err := listenLAN(testInvitation())
		if err != nil {
			t.Fatal(err)
		}
		accepted := make(chan net.Conn, 1)
		go lane.serve(func(peer net.Conn, confirm func() error) bool {
			if confirm() != nil {
				return false
			}
			accepted <- peer
			return true
		})
		peer, err := dialLAN(context.Background(), &lane.offer, testInvitation())
		lane.close()
		if err != nil {
			t.Fatalf("iteration %d: %v", iteration, err)
		}
		selected := <-accepted
		_ = peer.SetDeadline(time.Now().Add(time.Second))
		_ = selected.SetDeadline(time.Now().Add(time.Second))
		written := make(chan error, 1)
		go func() { _, err := selected.Write([]byte("selected")); written <- err }()
		var payload [8]byte
		_, err = io.ReadFull(peer, payload[:])
		writeErr := <-written
		_ = peer.Close()
		_ = selected.Close()
		if err != nil || writeErr != nil || string(payload[:]) != "selected" {
			t.Fatalf("iteration %d mismatched winner: %q %v %v", iteration, payload, err, writeErr)
		}
	}
}

func TestLANFallbackStopsWhenLinkCloses(t *testing.T) {
	loopbackLane(t)
	sender, _, _ := linkedPair(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		peer, err := listener.Accept()
		if err == nil {
			accepted <- peer
		}
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		openDirectPath(context.Background(), sender, testInvitation(), fileOffer{LAN: &lanOffer{Port: listener.Addr().(*net.TCPAddr).Port, Hosts: []string{"127.0.0.1"}}, Direct: &directOffer{SDP: "unused"}})
	}()
	select {
	case peer := <-accepted:
		defer peer.Close()
	case <-time.After(time.Second):
		t.Fatal("LAN dial never began")
	}
	sender.close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closed link did not cancel LAN setup")
	}
	if sender.direct.Load() != nil {
		t.Fatal("fallback attached a direct path after link closed")
	}
}

func TestLANReplacementIgnoresQueuedFailureFromRetiredPath(t *testing.T) {
	sender, _ := laneLinks(t)
	sender.directUsed.Store(true)
	retired := &directPath{}
	if err := sender.accept(linkItem{err: io.EOF, direct: true, path: retired}); err != nil {
		t.Fatalf("retired path ended active transfer: %v", err)
	}
	if err := sender.accept(linkItem{err: io.EOF, direct: true, path: sender.direct.Load()}); err == nil {
		t.Fatal("active path failure was ignored")
	}
}
