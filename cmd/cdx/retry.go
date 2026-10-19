package main

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// Only call retrySetup for operations that have not admitted a relay room or
// otherwise changed remote state. Code claims and transfer records cannot retry.
func retrySetup(ctx context.Context, operation func() error) error {
	return retrySetupWith(ctx, operation, func(attempt int) time.Duration {
		return (100 * time.Millisecond << attempt) + time.Duration(rand.Int64N(int64(50*time.Millisecond)))
	})
}
func retrySetupWith(ctx context.Context, operation func() error, delay func(int) time.Duration) error {
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := operation()
		if err == nil {
			return nil
		}
		if attempt == 2 || !transientSetup(err) {
			return err
		}
		timer := time.NewTimer(delay(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	panic("unreachable")
}
func transientSetup(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	var failure *Failure
	if errors.As(err, &failure) {
		return failure.Retry == retrySameRequest && (failure.Kind == failureNetwork || failure.Kind == failureBusy)
	}
	var dns *net.DNSError
	if errors.As(err, &dns) && dns.IsNotFound {
		return false
	}
	var certificate x509.CertificateInvalidError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	if errors.As(err, &certificate) || errors.As(err, &authority) || errors.As(err, &hostname) {
		return false
	}
	var network net.Error
	return errors.As(err, &network) || errors.Is(err, context.DeadlineExceeded)
}

func dialRelay(ctx context.Context, endpoint string) (*websocket.Conn, error) {
	setupCtx, cancelSetup := context.WithTimeout(ctx, 20*time.Second)
	defer cancelSetup()
	var connection *websocket.Conn
	err := retrySetup(setupCtx, func() error {
		dialCtx, cancel := context.WithTimeout(setupCtx, 10*time.Second)
		defer cancel()
		var response *http.Response
		var err error
		connection, response, err = websocket.DefaultDialer.DialContext(dialCtx, endpoint, http.Header{})
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if response != nil {
			retry := retryNever
			if response.StatusCode == 429 || response.StatusCode >= 500 {
				retry = retrySameRequest
			}
			return NewFailure(failureNetwork, fmt.Sprintf("CD relay rejected the connection (HTTP %d): check CD_RELAY_URL ends in /ws/v1 and matches CD_PUBLIC_URL", response.StatusCode), retry, err)
		}
		if dialCtx.Err() != nil {
			return NewFailure(failureNetwork, "connect to CD relay timed out: check your network and try again", retrySameRequest, err)
		}
		if transientSetup(err) {
			return failuref(failureNetwork, retrySameRequest, "connect to CD relay: %w", err)
		}
		return failuref(failureNetwork, retryNever, "connect to CD relay: %w", err)
	})
	if err != nil && ctx.Err() == nil && setupCtx.Err() != nil {
		return nil, NewFailure(failureNetwork, "connect to CD relay setup timed out within 20s: check your network and try again", retrySameRequest, err)
	}
	return connection, err
}
