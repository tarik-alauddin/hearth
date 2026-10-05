package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

var (
	// ErrBackupGone: S3 has no object at the link's key (404).
	ErrBackupGone = errors.New("backup no longer exists")
	// ErrLinkRefused: S3 refused the link (403). The link may have expired, or, since the signer
	// can't list the bucket, the backup may be gone: S3 answers a missing key with 403 then.
	ErrLinkRefused = errors.New("download link refused")
)

// Restore replaces dir with the gzipped tar at url (a presigned S3 link). The backup is unpacked
// beside dir first, and swapped in only once it's complete, so a failed restore leaves dir as it
// was. Entries that would land outside dir are refused.
func Restore(ctx context.Context, client *http.Client, url, dir string) error {
	staging, previous := dir+".restoring", dir+".previous"
	if err := recoverSwap(dir, staging, previous); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return ErrBackupGone
	case http.StatusForbidden:
		return ErrLinkRefused
	default:
		return fmt.Errorf("download: S3 returned %s", resp.Status)
	}

	if err := Unpack(resp.Body, staging); err != nil {
		return errors.Join(fmt.Errorf("unpack: %w", err), os.RemoveAll(staging))
	}
	return swap(dir, staging, previous)
}

// recoverSwap cleans up after a restore that was cut short: an unfinished unpack is discarded, and
// a world moved aside but never replaced is put back.
func recoverSwap(dir, staging, previous string) error {
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if _, err := os.Lstat(previous); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
		return os.Rename(previous, dir)
	}
	return os.RemoveAll(previous)
}

// swap moves dir aside, moves staging into its place, then deletes the old world. Renames on one
// filesystem are atomic, so dir is always either the old world or the new one.
func swap(dir, staging, previous string) error {
	if err := os.Rename(dir, previous); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(staging, dir); err != nil {
		return err
	}
	return os.RemoveAll(previous)
}

// Unpack writes the gzipped tar from r into dir, which must not exist yet. It restores modes,
// owners and modification times. It refuses absolute paths, paths with "..", hard links, and
// symlinks pointing outside dir; symlinks are created last, so nothing is written through one.
func Unpack(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		return err
	}
	type link struct{ path, target string }
	var links []link
	var dirs []*tar.Header // times are set last: writing into a directory changes its time
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name, err := safeName(hdr.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, hdr.FileInfo().Mode().Perm()); err != nil {
				return err
			}
			dirs = append(dirs, hdr)
		case tar.TypeReg:
			if err := writeFile(target, tr, hdr); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := safeLink(name, hdr.Linkname); err != nil {
				return err
			}
			links = append(links, link{target, hdr.Linkname})
			continue
		default:
			return fmt.Errorf("%s: unsupported entry type %q", hdr.Name, hdr.Typeflag)
		}
		if err := setOwner(target, hdr); err != nil {
			return err
		}
	}
	// gzip verifies its checksum at the end of the stream, which may be past the tar's end.
	if _, err := io.Copy(io.Discard, gz); err != nil {
		return err
	}
	for _, l := range links {
		if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
			return err
		}
		if err := realParent(dir, l.path); err != nil {
			return err
		}
		if err := os.Symlink(l.target, l.path); err != nil {
			return err
		}
	}
	for _, hdr := range dirs {
		name, _ := safeName(hdr.Name)
		if err := os.Chtimes(filepath.Join(dir, filepath.FromSlash(name)), time.Time{}, hdr.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func writeFile(target string, r io.Reader, hdr *tar.Header) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Chtimes(target, time.Time{}, hdr.ModTime)
}

// setOwner keeps the archive's owners, so the game's container user can still write its files.
// Only root can change owners; anyone else (tests, the harness) keeps their own.
func setOwner(target string, hdr *tar.Header) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return os.Lchown(target, hdr.Uid, hdr.Gid)
}

// safeName cleans an entry name, refusing one that would land outside the archive's root.
func safeName(name string) (string, error) {
	clean := path.Clean(strings.TrimSuffix(name, "/"))
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || clean == "." {
		return "", fmt.Errorf("%q: entry outside the backup's root", name)
	}
	return clean, nil
}

// safeLink refuses a symlink whose target leaves the archive's root.
func safeLink(name, target string) error {
	if path.IsAbs(target) {
		return fmt.Errorf("%q: symlink to an absolute path", name)
	}
	if resolved := path.Join(path.Dir(name), target); resolved != "." {
		if _, err := safeName(resolved); err != nil {
			return fmt.Errorf("%q: symlink outside the backup's root", name)
		}
	}
	return nil
}

// realParent refuses to create p if its directory goes through a symlink: safeLink judged the
// target from p's path as written, which only holds if that path is real.
func realParent(root, p string) error {
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, filepath.Dir(p))
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return err
	}
	if real != filepath.Join(base, rel) {
		return fmt.Errorf("%s: symlink inside a symlinked directory", p)
	}
	return nil
}
