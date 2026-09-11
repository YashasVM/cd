package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gorilla/websocket"
)

const chunkSize = 64 * 1024
const relayURL = "wss://cd.yash0.in/ws/"

var words = []string{
	"beep", "boop", "bork", "bonk", "blob", "cake", "clam", "clap", "dino", "drip",
	"duck", "flap", "goof", "honk", "jazz", "mochi", "muffin", "nacho", "noodle",
	"otter", "pickle", "pizza", "plop", "quack", "salsa", "snack", "spork", "taco",
	"tofu", "wacky", "waffle", "yeti", "zippy",
}

type metadata struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
}

func randomBytes(size int) ([]byte, error) {
	value := make([]byte, size)
	_, err := io.ReadFull(rand.Reader, value)
	return value, err
}

func shareCode() (string, error) {
	bytes, err := randomBytes(4)
	if err != nil {
		return "", err
	}
	parts := make([]string, len(bytes))
	for index, value := range bytes {
		parts[index] = words[int(value)%len(words)]
	}
	return strings.Join(parts, "-"), nil
}

func encrypt(block cipher.AEAD, key []byte, plaintext []byte) ([]byte, error) {
	nonce, err := randomBytes(block.NonceSize())
	if err != nil {
		return nil, err
	}
	return append(nonce, block.Seal(nil, nonce, plaintext, nil)...), nil
}

func sendEncrypted(connection *websocket.Conn, payload []byte) error {
	return connection.WriteMessage(websocket.TextMessage, []byte("data:"+base64.RawStdEncoding.EncodeToString(payload)))
}

func contentType(filename string) string {
	if value := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename))); value != "" {
		return value
	}
	return "application/octet-stream"
}

func relayEndpoint(code string) string {
	base := os.Getenv("CD_RELAY_URL")
	if base == "" {
		base = relayURL
	}
	return strings.TrimRight(base, "/") + "/" + url.PathEscape(code)
}

func runSender(filename, code string) error {
	key, err := base64.RawURLEncoding.DecodeString(os.Getenv("CD_SHARE_KEY"))
	if err != nil || len(key) != 32 {
		return errors.New("invalid CD_SHARE_KEY")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	connection, _, err := websocket.DefaultDialer.Dial(relayEndpoint(code), nil)
	if err != nil {
		return fmt.Errorf("connect to CD relay: %w", err)
	}
	defer connection.Close()
	if err := connection.WriteMessage(websocket.TextMessage, []byte("hello:sender")); err != nil {
		return err
	}
	if _, message, err := connection.ReadMessage(); err != nil || string(message) != "ready" {
		return errors.New("receiver did not connect")
	}
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	meta, err := json.Marshal(metadata{Filename: filepath.Base(filename), Mime: contentType(filename), Size: info.Size()})
	if err != nil {
		return err
	}
	encrypted, err := encrypt(aead, key, meta)
	if err != nil {
		return err
	}
	if err := sendEncrypted(connection, encrypted); err != nil {
		return err
	}
	buffer := make([]byte, chunkSize)
	for {
		count, readErr := file.Read(buffer)
		if count > 0 {
			encrypted, err = encrypt(aead, key, buffer[:count])
			if err != nil {
				return err
			}
			if err := sendEncrypted(connection, encrypted); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return connection.WriteMessage(websocket.TextMessage, []byte("done"))
}

func send(filename string, jsonOutput bool) error {
	info, err := os.Stat(filename)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("file must be regular")
	}
	code, err := shareCode()
	if err != nil {
		return err
	}
	key, err := randomBytes(32)
	if err != nil {
		return err
	}
	encodedKey := base64.RawURLEncoding.EncodeToString(key)
	command := exec.Command(os.Args[0], "--serve", filename, code)
	command.Env = append(os.Environ(), "CD_SHARE_KEY="+encodedKey)
	command.Stdout = io.Discard
	command.Stderr = os.Stderr
	configureDetached(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start CD sender: %w", err)
	}
	shareURL := "https://cd.yash0.in/" + code + "#" + encodedKey
	if jsonOutput {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"url": shareURL, "filename": filepath.Base(filename), "size": info.Size()})
	}
	_, err = fmt.Fprintln(os.Stdout, shareURL)
	return err
}

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "--serve" {
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "cdx: invalid sender process")
			os.Exit(2)
		}
		if err := runSender(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, "cdx sender:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "send" {
		fmt.Fprintln(os.Stderr, "usage: cdx send <file> [--json]")
		os.Exit(2)
	}
	jsonOutput := false
	for _, argument := range os.Args[3:] {
		if argument == "--json" {
			jsonOutput = true
		} else {
			fmt.Fprintf(os.Stderr, "cdx: unknown option %s\n", argument)
			os.Exit(2)
		}
	}
	if err := send(os.Args[2], jsonOutput); err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		os.Exit(1)
	}
}
