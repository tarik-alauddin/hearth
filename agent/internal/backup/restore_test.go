package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// serve answers every request with status and body.
func serve(t *testing.T, status int, body []byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// oldData is the game data a restore replaces.
func oldData(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "minecraft")
	if err := os.MkdirAll(filepath.Join(dir, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "world", "level.dat"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRestoreReplacesTheDataWithTheBackup(t *testing.T) {
	src, region := gameData(t)
	if err := os.Symlink("world", filepath.Join(src, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "server.properties"), 0o600); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err := Archive(&archive, game.BackupSpec{Dir: src, Exclude: []string{"logs", "*.jar"}}); err != nil {
		t.Fatal(err)
	}
	dir := oldData(t)
	if err := os.WriteFile(filepath.Join(dir, "only-in-old"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Restore(context.Background(), http.DefaultClient, serve(t, 200, archive.Bytes()), dir); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "world", "region", "r.0.0.mca")) != string(region) {
		t.Error("region file differs from the backup")
	}
	if read(t, filepath.Join(dir, "server.properties")) != "motd=hi\n" {
		t.Error("server.properties differs")
	}
	if info, _ := os.Stat(filepath.Join(dir, "server.properties")); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", info.Mode().Perm())
	}
	if target, err := os.Readlink(filepath.Join(dir, "current")); err != nil || target != "world" {
		t.Errorf("symlink %q, %v", target, err)
	}
	for _, gone := range []string{"only-in-old", "world/level.dat", "logs", "server.jar"} {
		if _, err := os.Lstat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Errorf("%s should not survive the restore", gone)
		}
	}
	for _, leftover := range []string{dir + ".restoring", dir + ".previous"} {
		if _, err := os.Lstat(leftover); !os.IsNotExist(err) {
			t.Errorf("%s left behind", leftover)
		}
	}
}

func TestFailedRestoresLeaveTheDataAsItWas(t *testing.T) {
	var archive bytes.Buffer
	src, _ := gameData(t)
	if err := Archive(&archive, game.BackupSpec{Dir: src}); err != nil {
		t.Fatal(err)
	}
	truncated := archive.Bytes()[:archive.Len()/2]
	for _, tc := range []struct {
		name   string
		status int
		body   []byte
		want   error
	}{
		{"backup gone", 404, nil, ErrBackupGone},
		{"link refused", 403, nil, ErrLinkRefused},
		{"server error", 500, nil, nil},
		{"truncated download", 200, truncated, nil},
		{"not a gzip", 200, []byte("<Error>nope</Error>"), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := oldData(t)
			err := Restore(context.Background(), http.DefaultClient, serve(t, tc.status, tc.body), dir)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if read(t, filepath.Join(dir, "world", "level.dat")) != "old" {
				t.Error("the old data should be untouched")
			}
			if _, err := os.Lstat(dir + ".restoring"); !os.IsNotExist(err) {
				t.Error("the half-unpacked backup should be removed")
			}
		})
	}
}

func TestRestorePutsBackDataMovedAsideByAnInterruptedSwap(t *testing.T) {
	dir := oldData(t)
	if err := os.Rename(dir, dir+".previous"); err != nil { // cut short between the two renames
		t.Fatal(err)
	}
	_ = Restore(context.Background(), http.DefaultClient, serve(t, 404, nil), dir)
	if read(t, filepath.Join(dir, "world", "level.dat")) != "old" {
		t.Error("the data moved aside should be back in place")
	}
}

// entry is one tar entry for tarball.
type entry struct {
	name, link string
	typ        byte
}

func tarball(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Linkname: e.link, Typeflag: e.typ, Mode: 0o644}
		if e.typ == tar.TypeDir {
			hdr.Mode = 0o755
		}
		if e.typ == tar.TypeReg {
			hdr.Size = 1
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			_, _ = tw.Write([]byte("x"))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestUnpackRefusesEntriesOutsideTheDataFolder(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries []entry
	}{
		{"parent path", []entry{{name: "../evil", typ: tar.TypeReg}}},
		{"nested parent path", []entry{{name: "world/../../evil", typ: tar.TypeReg}}},
		{"absolute path", []entry{{name: "/etc/evil", typ: tar.TypeReg}}},
		{"symlink out", []entry{{name: "out", link: "../..", typ: tar.TypeSymlink}}},
		{"absolute symlink", []entry{{name: "out", link: "/etc", typ: tar.TypeSymlink}}},
		{"hard link", []entry{{name: "a", typ: tar.TypeReg}, {name: "b", link: "a", typ: tar.TypeLink}}},
		{"symlink via a symlinked dir", []entry{
			{name: "d", link: ".", typ: tar.TypeSymlink},
			{name: "d/l", link: "..", typ: tar.TypeSymlink},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			err := Unpack(bytes.NewReader(tarball(t, tc.entries...)), filepath.Join(parent, "w"))
			if err == nil {
				t.Fatal("expected the archive to be refused")
			}
			if _, err := os.Lstat(filepath.Join(parent, "evil")); !os.IsNotExist(err) {
				t.Error("wrote outside the data folder")
			}
		})
	}
}

func TestUnpackAllowsSymlinksWithinTheDataFolder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "w")
	archive := tarball(t,
		entry{name: "world/", typ: tar.TypeDir},
		entry{name: "world/up", link: "..", typ: tar.TypeSymlink},
		entry{name: "current", link: "world", typ: tar.TypeSymlink},
	)
	if err := Unpack(bytes.NewReader(archive), dir); err != nil {
		t.Fatal(err)
	}
	if target, _ := os.Readlink(filepath.Join(dir, "world", "up")); !strings.HasSuffix(target, "..") {
		t.Errorf("link %q", target)
	}
}
