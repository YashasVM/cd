package cli

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"cdx/internal/cli"
	"cdx/src/models"
	"cdx/src/webassets"
	"cdx/src/webcli"
	"cdx/src/webrelay"
	log "github.com/schollz/logger"
)

// serve implements `cdx serve`: it runs the built-in browser receive page.
func serve(c *cli.Context) error {
	relays := strings.TrimSpace(c.String("relays"))
	if relays == "" {
		relays = models.DEFAULT_RELAY
	}
	fmt.Printf("Browser receive page: http://%s\nPress Ctrl+C to stop.\n", strings.TrimPrefix(c.String("bind"), "0.0.0.0:"))
	return webcli.Run(context.Background(), []string{"cdx", "--bind", c.String("bind"), "--relays", relays})
}

// embeddedWebServer is a best-effort browser-receive server started
// alongside `cdx send` so recipients can open a share link directly.
type embeddedWebServer struct {
	baseURL string
	cancel  context.CancelFunc
	done    chan struct{}
}

// lanIP returns the preferred non-loopback IPv4 address of this machine.
func lanIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			conn.Close()
			return addr.IP.String()
		}
		conn.Close()
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	return "127.0.0.1"
}

// startEmbeddedWeb launches the built-in browser receive page on the first
// free port in 9014..9023. The browser connects back to the sender's own
// local relay.
func startEmbeddedWeb(localRelayPort, transfers int) (*embeddedWebServer, error) {
	var lastErr error
	for port := 9014; port <= 9023; port++ {
		srv, err := tryStartWeb(localRelayPort, transfers, port)
		if err == nil {
			return srv, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("no free port for embedded web server")
}

func tryStartWeb(localRelayPort, transfers, webPort int) (*embeddedWebServer, error) {
	ctx, cancel := context.WithCancel(context.Background())
	srv := &embeddedWebServer{cancel: cancel, done: make(chan struct{})}

	ports := make([]string, 0, transfers+1)
	for i := 0; i <= transfers; i++ {
		ports = append(ports, strconv.Itoa(localRelayPort+i))
	}
	bind := fmt.Sprintf("0.0.0.0:%d", webPort)
	go func() {
		defer close(srv.done)
		err := webrelay.Run(ctx, webrelay.Config{
			ListenAddress: bind,
			PublicAddress: bind,
			RelayHosts:    []string{fmt.Sprintf("127.0.0.1:%d", localRelayPort)},
			RelayPassword: models.DEFAULT_PASSPHRASE,
			AllowedPorts:  ports,
			StaticFiles:   webassets.Files(),
		})
		if err != nil && ctx.Err() == nil {
			log.Debugf("embedded web server on %s stopped: %v", bind, err)
		}
	}()

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(webPort))
	if waitForListener(addr, 2*time.Second) {
		srv.baseURL = fmt.Sprintf("http://%s:%d", lanIP(), webPort)
		log.Debugf("embedded web receive server at %s", srv.baseURL)
		return srv, nil
	}
	cancel()
	<-srv.done
	return nil, fmt.Errorf("could not bind %s", bind)
}

func waitForListener(addr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func (s *embeddedWebServer) stop() {
	if s == nil {
		return
	}
	s.cancel()
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
	}
}

// resolveWebBaseURL decides the browser-receive base URL: an explicit value
// wins, otherwise an embedded web server is started for LAN sharing.
func resolveWebBaseURL(explicit string, allowEmbedded bool, localRelayPort, transfers int) (string, func()) {
	explicit = strings.TrimSpace(explicit)
	if explicit != "" {
		return strings.TrimRight(explicit, "/"), func() {}
	}
	if !allowEmbedded {
		return "", func() {}
	}
	srv, err := startEmbeddedWeb(localRelayPort, transfers)
	if err != nil {
		log.Warnf("could not start built-in browser receiver (%v); share the code instead", err)
		return "", func() {}
	}
	return srv.baseURL, srv.stop
}
