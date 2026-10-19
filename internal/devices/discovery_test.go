package devices

import (
	"bytes"
	"net"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
)

func TestDiscoveryPacketHasResolveRecordsAndNoCredential(t *testing.T) {
	pair := testPair(t)
	packet, err := DiscoveryPacket(pair.PairID, 4567, []net.IP{net.ParseIP("192.168.1.9"), net.ParseIP("fd00::9")}, 120)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(packet, []byte(pair.Secret)) {
		t.Fatal("secret advertised")
	}
	var parsed dnsmessage.Message
	if err = parsed.Unpack(packet); err != nil {
		t.Fatal(err)
	}
	if !parsed.Header.Response || !parsed.Header.Authoritative {
		t.Fatal("announcement not authoritative response")
	}
	if len(parsed.Answers) != 5 {
		t.Fatalf("expected PTR/SRV/TXT/A/AAAA, got %d records", len(parsed.Answers))
	}
	counts := map[dnsmessage.Type]int{}
	for _, record := range parsed.Answers {
		counts[record.Header.Type]++
		if record.Header.TTL != 120 {
			t.Fatal("wrong TTL")
		}
		switch body := record.Body.(type) {
		case *dnsmessage.PTRResource:
			if record.Header.Name.String() != ServiceType || body.PTR.String() != pair.PairID+"."+ServiceType {
				t.Fatal("wrong browse record")
			}
		case *dnsmessage.SRVResource:
			if body.Port != 4567 || body.Target.String() != "cdx-"+pair.PairID+".local." {
				t.Fatal("wrong resolve address")
			}
		case *dnsmessage.TXTResource:
			if len(body.TXT) != 2 || body.TXT[0] != "pairId="+pair.PairID || body.TXT[1] != "version=1" {
				t.Fatalf("unexpected discovery metadata: %+v", body.TXT)
			}
		case *dnsmessage.AResource:
			if body.A != [4]byte{192, 168, 1, 9} {
				t.Fatal("wrong IPv4")
			}
		case *dnsmessage.AAAAResource:
			if net.IP(body.AAAA[:]).String() != "fd00::9" {
				t.Fatal("wrong IPv6")
			}
		}
	}
	if counts[dnsmessage.TypeTXT] != 1 || counts[dnsmessage.TypeA] != 1 {
		t.Fatal("missing records")
	}
	goodbye, err := DiscoveryPacket(pair.PairID, 4567, []net.IP{net.ParseIP("192.168.1.9")}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = parsed.Unpack(goodbye); err != nil {
		t.Fatal(err)
	}
	for _, record := range parsed.Answers {
		if record.Header.TTL != 0 {
			t.Fatal("goodbye must expire records")
		}
	}
}
func TestDiscoveryRejectsPublicAddressesAndInvalidIdentity(t *testing.T) {
	p := testPair(t)
	for _, ip := range []string{"8.8.8.8", "127.0.0.1", "0.0.0.0", "::1", "2001:4860:4860::8888"} {
		if _, err := DiscoveryPacket(p.PairID, 1234, []net.IP{net.ParseIP(ip)}, 120); err == nil {
			t.Errorf("public/loopback discovery %s allowed", ip)
		}
	}
	if _, err := DiscoveryPacket("name-only", 1234, []net.IP{net.ParseIP("192.168.1.4")}, 120); err == nil {
		t.Fatal("noncredential identity allowed")
	}
	if _, err := DiscoveryPacket(p.PairID, 0, []net.IP{net.ParseIP("192.168.1.4")}, 120); err == nil {
		t.Fatal("port zero allowed")
	}
}
