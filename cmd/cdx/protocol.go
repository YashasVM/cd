package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
)

const (
	invitationBytes = 48
	headerBytes     = 12
	maxRecordBytes  = 80 * 1024
	protocolVersion = 1
)

type direction byte
type messageKind byte

const (
	senderDirection direction = iota
	receiverDirection
)

const (
	kindOffer messageKind = iota + 1
	kindChunk
	kindEnd
	kindAccept
	kindAck
	kindComplete
)

type invitation struct {
	id  [16]byte
	key [32]byte
}

func newInvitation(random io.Reader) (invitation, error) {
	var value invitation
	buffer := make([]byte, invitationBytes)
	if _, err := io.ReadFull(random, buffer); err != nil {
		return value, fmt.Errorf("generate transfer secret: %w", err)
	}
	copy(value.id[:], buffer[:16])
	copy(value.key[:], buffer[16:])
	return value, nil
}

func (value invitation) encodedID() string {
	return base64.RawURLEncoding.EncodeToString(value.id[:])
}

func (value invitation) encodedKey() string {
	return base64.RawURLEncoding.EncodeToString(value.key[:])
}

func derive(secret, salt []byte, info string) ([]byte, error) {
	return hkdf.Key[hash.Hash](sha256.New, secret, salt, info, 32)
}

func (value invitation) receiverToken() ([]byte, error) {
	return derive(value.key[:], value.id[:], "cd-transfer-v1 receiver join")
}

func (value invitation) receiverTokenHash() ([]byte, error) {
	token, err := value.receiverToken()
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(token)
	return digest[:], nil
}

type recordSealer struct {
	aead      cipher.AEAD
	id        [16]byte
	direction direction
	sequence  uint64
}

type recordOpener struct {
	aead      cipher.AEAD
	id        [16]byte
	direction direction
	sequence  uint64
}

func newRecordAEAD(value invitation, valueDirection direction) (cipher.AEAD, error) {
	info := "cd-transfer-v1 sender frames"
	if valueDirection == receiverDirection {
		info = "cd-transfer-v1 receiver frames"
	}
	key, err := derive(value.key[:], value.id[:], info)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func newSealer(value invitation, valueDirection direction) (*recordSealer, error) {
	aead, err := newRecordAEAD(value, valueDirection)
	return &recordSealer{aead: aead, id: value.id, direction: valueDirection}, err
}

func newOpener(value invitation, valueDirection direction) (*recordOpener, error) {
	aead, err := newRecordAEAD(value, valueDirection)
	return &recordOpener{aead: aead, id: value.id, direction: valueDirection}, err
}

func validKind(valueDirection direction, kind messageKind) bool {
	if valueDirection == senderDirection {
		return kind >= kindOffer && kind <= kindEnd
	}
	return kind >= kindAccept && kind <= kindComplete
}

func recordNonce(valueDirection direction, sequence uint32) []byte {
	nonce := make([]byte, 12)
	copy(nonce, []byte("CDS1"))
	if valueDirection == receiverDirection {
		copy(nonce, []byte("CDR1"))
	}
	binary.BigEndian.PutUint64(nonce[4:], uint64(sequence))
	return nonce
}

func recordAAD(header []byte, id [16]byte) []byte {
	aad := make([]byte, 0, headerBytes+len(id))
	aad = append(aad, header...)
	return append(aad, id[:]...)
}

func (value *recordSealer) seal(kind messageKind, plaintext []byte) ([]byte, error) {
	if !validKind(value.direction, kind) {
		return nil, errors.New("message kind is invalid for direction")
	}
	if value.sequence > uint64(^uint32(0)) {
		return nil, errors.New("record sequence exhausted")
	}
	ciphertextLength := len(plaintext) + value.aead.Overhead()
	if headerBytes+ciphertextLength > maxRecordBytes {
		return nil, errors.New("record is too large")
	}
	header := make([]byte, headerBytes, headerBytes+ciphertextLength)
	copy(header, []byte("CD"))
	header[2] = protocolVersion
	header[3] = byte(kind)
	sequence := uint32(value.sequence)
	binary.BigEndian.PutUint32(header[4:8], sequence)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(plaintext)))
	record := value.aead.Seal(header, recordNonce(value.direction, sequence), plaintext, recordAAD(header, value.id))
	value.sequence++
	return record, nil
}

func (value *recordOpener) open(record []byte) (messageKind, []byte, error) {
	if len(record) < headerBytes+value.aead.Overhead() || len(record) > maxRecordBytes {
		return 0, nil, errors.New("record length is invalid")
	}
	header := record[:headerBytes]
	if string(header[:2]) != "CD" || header[2] != protocolVersion {
		return 0, nil, errors.New("record protocol is invalid")
	}
	kind := messageKind(header[3])
	if !validKind(value.direction, kind) {
		return 0, nil, errors.New("message kind is invalid for direction")
	}
	sequence := binary.BigEndian.Uint32(header[4:8])
	if value.sequence > uint64(^uint32(0)) || uint64(sequence) != value.sequence {
		return 0, nil, fmt.Errorf("record sequence %d, expected %d", sequence, value.sequence)
	}
	plaintextLength := binary.BigEndian.Uint32(header[8:12])
	if uint64(plaintextLength)+uint64(headerBytes+value.aead.Overhead()) != uint64(len(record)) {
		return 0, nil, errors.New("record plaintext length is invalid")
	}
	plaintext, err := value.aead.Open(nil, recordNonce(value.direction, sequence), record[headerBytes:], recordAAD(header, value.id))
	if err != nil {
		return 0, nil, errors.New("record authentication failed")
	}
	value.sequence++
	return kind, plaintext, nil
}
