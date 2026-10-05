package minecraft

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"path"
	"testing"

	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

func TestContainer(t *testing.T) {
	a := New()
	spec := a.Container(game.Config{
		Game:      "minecraft-java",
		Version:   "1.21.4",
		Image:     "docker.io/itzg/minecraft-server",
		Port:      25565,
		DataDir:   "/srv/hearth",
		MemoryMiB: 3900,
	})

	if spec.Image != "docker.io/itzg/minecraft-server" {
		t.Errorf("image %q should come from the config", spec.Image)
	}
	for k, want := range map[string]string{
		"EULA": "TRUE", "TYPE": "VANILLA", "VERSION": "1.21.4", "MEMORY": "2925M",
		"SERVER_PORT": "25565", "ENABLE_RCON": "true", "RCON_PORT": "25575",
	} {
		if spec.Env[k] != want {
			t.Errorf("env %s = %q, want %q", k, spec.Env[k], want)
		}
	}
	if len(spec.Env["RCON_PASSWORD"]) < 32 {
		t.Error("RCON password should be long and random")
	}
	if spec.Ports[0].HostIP != "0.0.0.0" || spec.Ports[0].HostPort != 25565 {
		t.Errorf("game port %+v should be public", spec.Ports[0])
	}
	if spec.Ports[1].HostIP != "127.0.0.1" || spec.Ports[1].HostPort != 25575 {
		t.Errorf("RCON port %+v must be loopback only", spec.Ports[1])
	}
	if spec.Mounts[0].Source != "/srv/hearth/minecraft" || spec.Mounts[0].Target != "/data" {
		t.Errorf("mount %+v", spec.Mounts[0])
	}
	if New().Container(game.Config{}).Env["RCON_PASSWORD"] == spec.Env["RCON_PASSWORD"] {
		t.Error("each run should get a new RCON password")
	}
}

func TestBackupKeepsTheWorldNotTheServerFiles(t *testing.T) {
	spec := New().Backup(game.Config{DataDir: "/srv/hearth"})
	if spec.Dir != "/srv/hearth/minecraft" {
		t.Errorf("dir %q should be the container's data mount", spec.Dir)
	}
	for _, pattern := range spec.Exclude {
		if _, err := path.Match(pattern, ""); err != nil {
			t.Errorf("bad pattern %q: %v", pattern, err)
		}
	}
	for _, kept := range []string{"world", "world/region/r.0.0.mca", "server.properties", "ops.json", "whitelist.json", "mods/x.jar"} {
		if spec.Excludes(kept) {
			t.Errorf("%s should be backed up", kept)
		}
	}
	for _, skipped := range []string{"minecraft_server.1.21.4.jar", "libraries", "versions", "logs", ".rcon-cli.env"} {
		if !spec.Excludes(skipped) {
			t.Errorf("%s should be excluded", skipped)
		}
	}
}

func TestHeapSize(t *testing.T) {
	for mem, want := range map[int]string{0: "1024M", 1000: "1024M", 3900: "2925M", 7800: "5850M"} {
		if got := heapSize(mem); got != want {
			t.Errorf("heapSize(%d) = %s, want %s", mem, got, want)
		}
	}
}

func TestReadyPingsTheGamePort(t *testing.T) {
	a := New()
	a.Container(game.Config{Port: 25599})
	var pinged string
	a.ping = func(_ context.Context, addr string) (Status, error) {
		pinged = addr
		return Status{}, nil
	}
	if err := a.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pinged != "127.0.0.1:25599" {
		t.Errorf("pinged %s", pinged)
	}

	a.ping = func(context.Context, string) (Status, error) { return Status{}, errors.New("refused") }
	if a.Ready(context.Background()) == nil {
		t.Error("Ready should fail while the ping fails")
	}
}

func TestPlayersComesFromTheServerListPing(t *testing.T) {
	a := New()
	a.Container(game.Config{Port: 25599})
	var pinged string
	a.ping = func(_ context.Context, addr string) (Status, error) {
		pinged = addr
		var s Status
		s.Players.Online, s.Players.Max = 3, 20
		return s, nil
	}
	if n, err := a.Players(context.Background()); err != nil || n != 3 {
		t.Fatalf("got %d, %v", n, err)
	}
	if pinged != "127.0.0.1:25599" {
		t.Errorf("pinged %s", pinged)
	}

	a.ping = func(context.Context, string) (Status, error) { return Status{}, errors.New("refused") }
	if _, err := a.Players(context.Background()); err == nil {
		t.Error("a failed ping must be an error, not zero players")
	}
}

func TestSaveFlushesOverRCON(t *testing.T) {
	a := New()
	spec := a.Container(game.Config{Port: 25565})
	var got [3]string
	a.rcon = func(_ context.Context, addr, password, command string) (string, error) {
		got = [3]string{addr, password, command}
		return "Saved the game", nil
	}
	if err := a.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := [3]string{"127.0.0.1:25575", spec.Env["RCON_PASSWORD"], "save-all flush"}
	if got != want {
		t.Errorf("rcon %v, want %v", got, want)
	}
}

// TestPing runs Ping against a fake server that checks the handshake and answers like Minecraft.
func TestPing(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)

		handshake, err := readPacket(r)
		if err != nil {
			serverErr <- err
			return
		}
		hs := bytes.NewReader(handshake)
		id, _ := readVarInt(hs)
		protocol, _ := readVarInt(hs)
		hostLen, _ := readVarInt(hs)
		host := make([]byte, hostLen)
		_, _ = io.ReadFull(hs, host)
		var port uint16
		_ = binary.Read(hs, binary.BigEndian, &port)
		next, _ := readVarInt(hs)
		if id != 0 || protocol != -1 || string(host) != "127.0.0.1" || next != 1 {
			serverErr <- errors.New("bad handshake")
			return
		}
		if request, err := readPacket(r); err != nil || !bytes.Equal(request, []byte{0x00}) {
			serverErr <- errors.New("bad status request")
			return
		}

		var body bytes.Buffer
		writeVarInt(&body, 0x00)
		writeString(&body, `{"version":{"name":"1.21.4","protocol":769},"players":{"max":20,"online":3}}`)
		serverErr <- writePacket(conn, body.Bytes())
	}()

	status, err := Ping(context.Background(), ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
	if status.Version.Name != "1.21.4" || status.Players.Online != 3 || status.Players.Max != 20 {
		t.Errorf("status %+v", status)
	}
}

func TestPingFailsWhenNothingListens(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	if _, err := Ping(context.Background(), addr); err == nil {
		t.Error("expected an error")
	}
}

func readPacket(r *bufio.Reader) ([]byte, error) {
	n, err := readVarInt(r)
	if err != nil {
		return nil, err
	}
	b := make([]byte, n)
	_, err = io.ReadFull(r, b)
	return b, err
}

func TestVarIntRoundTrip(t *testing.T) {
	for _, v := range []int32{0, 1, 127, 128, 255, 25565, 2097151, -1, -2147483648} {
		var b bytes.Buffer
		writeVarInt(&b, v)
		got, err := readVarInt(&b)
		if err != nil || got != v {
			t.Errorf("round trip %d: got %d, %v", v, got, err)
		}
	}
}
