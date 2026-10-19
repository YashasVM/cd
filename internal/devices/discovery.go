package devices

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
)

const ServiceType = "_cdx._tcp.local."

// DiscoveryPacket exposes the exact announcement for fixture tests. Addresses
// must belong to the selected interface and never include public IP addresses.
func DiscoveryPacket(pairID string, port int, addresses []net.IP, ttl uint32) ([]byte, error) {
	if _, err := decode(pairID, 16); err != nil {
		return nil, err
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("invalid discovery port")
	}
	if len(addresses) == 0 || len(addresses) > 32 {
		return nil, errors.New("invalid discovery addresses")
	}
	service := dnsmessage.MustNewName(ServiceType)
	instance := dnsmessage.MustNewName(pairID + "." + ServiceType)
	host := dnsmessage.MustNewName("cdx-" + pairID + ".local.")
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{Response: true, Authoritative: true})
	b.EnableCompression()
	if err := b.StartAnswers(); err != nil {
		return nil, err
	}
	header := func(name dnsmessage.Name, t dnsmessage.Type) dnsmessage.ResourceHeader {
		return dnsmessage.ResourceHeader{Name: name, Type: t, Class: dnsmessage.ClassINET, TTL: ttl}
	}
	if err := b.PTRResource(header(service, dnsmessage.TypePTR), dnsmessage.PTRResource{PTR: instance}); err != nil {
		return nil, err
	}
	h := header(instance, dnsmessage.TypeSRV)
	h.Class |= 0x8000
	if err := b.SRVResource(h, dnsmessage.SRVResource{Port: uint16(port), Target: host}); err != nil {
		return nil, err
	}
	h = header(instance, dnsmessage.TypeTXT)
	h.Class |= 0x8000
	if err := b.TXTResource(h, dnsmessage.TXTResource{TXT: []string{"pairId=" + pairID, "version=1"}}); err != nil {
		return nil, err
	}
	for _, ip := range addresses {
		if !(ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
			return nil, errors.New("discovery address must be local")
		}
		if v4 := ip.To4(); v4 != nil {
			h = header(host, dnsmessage.TypeA)
			h.Class |= 0x8000
			if err := b.AResource(h, dnsmessage.AResource{A: [4]byte(v4)}); err != nil {
				return nil, err
			}
		} else if v6 := ip.To16(); v6 != nil {
			h = header(host, dnsmessage.TypeAAAA)
			h.Class |= 0x8000
			if err := b.AAAAResource(h, dnsmessage.AAAAResource{AAAA: [16]byte(v6)}); err != nil {
				return nil, err
			}
		}
	}
	return b.Finish()
}

type advertiserInterface struct {
	network   *net.Interface
	addresses []net.IP
}

// Advertise announces the pair on active multicast IPv4 LAN interfaces. It
// responds to DNS-SD browse/resolve questions and withdraws records on cancel.
// Callers should surface setup errors; discovery failure need not stop relay use.
func Advertise(ctx context.Context, pairID string, port int) error {
	interfaces, err := net.Interfaces()
	if err != nil {
		return err
	}
	var active []advertiserInterface
	for i := range interfaces {
		iface := &interfaces[i]
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagMulticast == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		var ips []net.IP
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
				ips = append(ips, ip)
			}
		}
		if len(ips) > 0 {
			active = append(active, advertiserInterface{iface, ips})
		}
	}
	if len(active) == 0 {
		return errors.New("no multicast LAN interfaces")
	}
	socket, err := net.ListenMulticastUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353})
	if err != nil {
		return err
	}
	defer socket.Close()
	packetConn := ipv4.NewPacketConn(socket)
	group := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	packetConn.SetMulticastTTL(255)
	packetConn.SetMulticastLoopback(false)
	for _, iface := range active {
		_ = packetConn.JoinGroup(iface.network, group)
	}
	send := func(ttl uint32) error {
		var last error
		success := false
		for _, iface := range active {
			packet, err := DiscoveryPacket(pairID, port, iface.addresses, ttl)
			if err != nil {
				return err
			}
			if err = packetConn.SetMulticastInterface(iface.network); err != nil {
				last = err
				continue
			}
			if _, err = packetConn.WriteTo(packet, &ipv4.ControlMessage{IfIndex: iface.network.Index}, group); err != nil {
				last = err
				continue
			}
			success = true
		}
		if !success {
			return fmt.Errorf("mDNS announcement failed: %w", last)
		}
		return nil
	}
	if err = send(120); err != nil {
		return err
	}
	defer send(0)
	lastAnnouncement := time.Now()
	buffer := make([]byte, 9000)
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		_ = socket.SetReadDeadline(time.Now().Add(time.Second))
		n, remote, err := socket.ReadFromUDP(buffer)
		if err != nil {
			if e, ok := err.(net.Error); !ok || !e.Timeout() {
				return err
			}
		} else {
			var p dnsmessage.Parser
			head, err := p.Start(buffer[:n])
			if err == nil && !head.Response {
				questions, err := p.AllQuestions()
				if err == nil {
					for _, question := range questions {
						name := strings.ToLower(question.Name.String())
						if name == ServiceType || name == strings.ToLower(pairID+"."+ServiceType) || name == strings.ToLower("cdx-"+pairID+".local.") {
							if time.Since(lastAnnouncement) >= 250*time.Millisecond {
								if remote.Port != 5353 { // Legacy unicast queries still receive complete DNS-SD records.
									for _, iface := range active {
										packet, _ := DiscoveryPacket(pairID, port, iface.addresses, 120)
										_, _ = socket.WriteToUDP(packet, remote)
									}
								} else {
									_ = send(120)
								}
								lastAnnouncement = time.Now()
							}
							break
						}
					}
				}
			}
		}
		if time.Since(lastAnnouncement) > 60*time.Second {
			if err = send(120); err != nil {
				return err
			}
			lastAnnouncement = time.Now()
		}
	}
}
