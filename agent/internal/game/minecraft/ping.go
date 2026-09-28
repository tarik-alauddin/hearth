package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// Status is the part of a server list ping response the agent uses.
type Status struct {
	Version struct {
		Name string `json:"name"`
	} `json:"version"`
	Players struct {
		Online int `json:"online"`
		Max    int `json:"max"`
	} `json:"players"`
}

// Ping performs a Minecraft server list ping (https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping):
// a handshake with next state "status", then a status request.
func Ping(ctx context.Context, addr string) (Status, error) {
	var status Status
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return status, err
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return status, err
	}

	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return status, err
	}
	defer conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	var handshake bytes.Buffer
	writeVarInt(&handshake, 0x00) // handshake packet
	writeVarInt(&handshake, -1)   // protocol version: -1 means "just asking for status"
	writeString(&handshake, host)
	_ = binary.Write(&handshake, binary.BigEndian, uint16(port))
	writeVarInt(&handshake, 1) // next state: status
	if err := writePacket(conn, handshake.Bytes()); err != nil {
		return status, err
	}
	if err := writePacket(conn, []byte{0x00}); err != nil { // status request
		return status, err
	}

	r := bufio.NewReader(conn)
	if _, err := readVarInt(r); err != nil { // packet length
		return status, err
	}
	id, err := readVarInt(r)
	if err != nil {
		return status, err
	}
	if id != 0x00 {
		return status, fmt.Errorf("unexpected packet id %d", id)
	}
	n, err := readVarInt(r)
	if err != nil {
		return status, err
	}
	if n < 0 || n > 1<<20 {
		return status, fmt.Errorf("status response length %d out of range", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return status, err
	}
	if err := json.Unmarshal(body, &status); err != nil {
		return status, fmt.Errorf("decode status: %w", err)
	}
	return status, nil
}

func writePacket(w io.Writer, payload []byte) error {
	var frame bytes.Buffer
	writeVarInt(&frame, int32(len(payload)))
	frame.Write(payload)
	_, err := w.Write(frame.Bytes())
	return err
}

func writeString(b *bytes.Buffer, s string) {
	writeVarInt(b, int32(len(s)))
	b.WriteString(s)
}

func writeVarInt(b *bytes.Buffer, v int32) {
	u := uint32(v)
	for {
		if u&^0x7f == 0 {
			b.WriteByte(byte(u))
			return
		}
		b.WriteByte(byte(u&0x7f | 0x80))
		u >>= 7
	}
}

func readVarInt(r io.ByteReader) (int32, error) {
	var result uint32
	for shift := 0; shift < 35; shift += 7 {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		result |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return int32(result), nil
		}
	}
	return 0, errors.New("varint too long")
}
