package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

const testKey = "servers/s1/20261004T120000Z.tar.gz"

type fakeAPI struct {
	done []string
}

func (f *fakeAPI) BackupCredentials(context.Context) (api.BackupTarget, error) {
	var t api.BackupTarget
	t.Bucket, t.Key, t.Region = "backups", testKey, "us-west-2"
	t.Credentials.SessionToken = "token"
	return t, nil
}

func (f *fakeAPI) BackupDone(_ context.Context, key string) error {
	f.done = append(f.done, key)
	return nil
}

// fakeS3 keeps one multipart upload in memory.
type fakeS3 struct {
	mu        sync.Mutex
	parts     map[int32][]byte
	completed []byte
	aborted   bool
	failPart  int32 // UploadPart fails for this part number
	checksums []string
}

func (f *fakeS3) CreateMultipartUpload(_ context.Context, in *s3.CreateMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error) {
	if *in.Bucket != "backups" || *in.Key != testKey || in.ChecksumAlgorithm != "CRC32" {
		return nil, fmt.Errorf("unexpected create %+v", in)
	}
	f.parts = map[int32][]byte{}
	return &s3.CreateMultipartUploadOutput{UploadId: aws.String("u1")}, nil
}

func (f *fakeS3) UploadPart(_ context.Context, in *s3.UploadPartInput, _ ...func(*s3.Options)) (*s3.UploadPartOutput, error) {
	n := *in.PartNumber
	if n == f.failPart {
		return nil, errors.New("connection reset")
	}
	body, _ := io.ReadAll(in.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parts[n] = body
	return &s3.UploadPartOutput{ETag: aws.String(fmt.Sprintf("etag-%d", n)), ChecksumCRC32: aws.String(fmt.Sprintf("crc-%d", n))}, nil
}

func (f *fakeS3) CompleteMultipartUpload(_ context.Context, in *s3.CompleteMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CompleteMultipartUploadOutput, error) {
	var all []byte
	for i, part := range in.MultipartUpload.Parts {
		if *part.PartNumber != int32(i+1) || *part.ETag != fmt.Sprintf("etag-%d", i+1) {
			return nil, fmt.Errorf("part %d out of order: %+v", i+1, part)
		}
		f.checksums = append(f.checksums, aws.ToString(part.ChecksumCRC32))
		all = append(all, f.parts[*part.PartNumber]...)
	}
	f.completed = all
	return &s3.CompleteMultipartUploadOutput{}, nil
}

func (f *fakeS3) AbortMultipartUpload(context.Context, *s3.AbortMultipartUploadInput, ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
	f.aborted = true
	return &s3.AbortMultipartUploadOutput{}, nil
}

// gameData lays out a game data directory: a save file bigger than several parts, plus files to exclude.
func gameData(t *testing.T) (dir string, region []byte) {
	t.Helper()
	dir = t.TempDir()
	region = make([]byte, 5000) // random, so it doesn't compress below a few parts
	_, _ = rand.Read(region)
	for name, content := range map[string][]byte{
		"world/region/r.0.0.mca": region,
		"server.properties":      []byte("motd=hi\n"),
		"logs/latest.log":        []byte("noise"),
		"server.jar":             []byte("jar"),
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, content, 0o640); err != nil {
			t.Fatal(err)
		}
	}
	return dir, region
}

// untar reads a gzipped tar into name → content ("" for directories).
func untar(t *testing.T, archive []byte) map[string]string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	files := map[string]string{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatal(err)
		}
		content, _ := io.ReadAll(tr)
		files[hdr.Name] = string(content)
	}
}

func TestBackupStreamsTheArchiveInPartsAndRecordsIt(t *testing.T) {
	dir, region := gameData(t)
	if err := os.Symlink("world", filepath.Join(dir, "current")); err != nil {
		t.Fatal(err)
	}
	store, apiFake := &fakeS3{}, &fakeAPI{}
	b := &Backuper{API: apiFake, NewS3: func(target api.BackupTarget) S3 {
		if target.Credentials.SessionToken != "token" {
			t.Error("the S3 client should use the API's credentials")
		}
		return store
	}, PartSize: 1024}

	res, err := b.Backup(context.Background(), game.BackupSpec{Dir: dir, Exclude: []string{"logs", "*.jar"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Key != testKey || res.Bytes != int64(len(store.completed)) {
		t.Errorf("result %+v, uploaded %d bytes", res, len(store.completed))
	}
	if len(store.parts) < 4 {
		t.Errorf("expected several parts, got %d", len(store.parts))
	}
	if !slices.Equal(store.checksums[:2], []string{"crc-1", "crc-2"}) {
		t.Errorf("completion should carry each part's checksum: %v", store.checksums)
	}
	if !slices.Equal(apiFake.done, []string{testKey}) {
		t.Errorf("recorded %v", apiFake.done)
	}

	files := untar(t, store.completed)
	var names []string
	for name := range files {
		names = append(names, name)
	}
	slices.Sort(names)
	want := []string{"current", "server.properties", "world/", "world/region/", "world/region/r.0.0.mca"}
	if !slices.Equal(names, want) {
		t.Errorf("archived %v, want %v", names, want)
	}
	if files["world/region/r.0.0.mca"] != string(region) {
		t.Error("region file content differs")
	}
}

func TestFailedUploadIsAbortedAndNotRecorded(t *testing.T) {
	dir, _ := gameData(t)
	store, apiFake := &fakeS3{failPart: 2}, &fakeAPI{}
	b := &Backuper{API: apiFake, NewS3: func(api.BackupTarget) S3 { return store }, PartSize: 1024}

	_, err := b.Backup(context.Background(), game.BackupSpec{Dir: dir})
	if err == nil || !strings.Contains(err.Error(), "part 2: connection reset") {
		t.Fatalf("got %v", err)
	}
	if !store.aborted || store.completed != nil {
		t.Error("the upload should be aborted, not completed")
	}
	if len(apiFake.done) != 0 {
		t.Error("a failed backup must not be recorded")
	}
}

func TestNothingToBackUp(t *testing.T) {
	apiFake := &fakeAPI{}
	b := &Backuper{API: apiFake, NewS3: func(api.BackupTarget) S3 { t.Fatal("should not upload"); return nil }}
	if _, err := b.Backup(context.Background(), game.BackupSpec{Dir: filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestSmallArchiveIsOnePart(t *testing.T) {
	store := &fakeS3{}
	n, err := upload(context.Background(), store, "backups", testKey, strings.NewReader("tiny"), 1024)
	if err != nil || n != 4 || len(store.parts) != 1 || string(store.completed) != "tiny" {
		t.Fatalf("n=%d err=%v parts=%d completed=%q", n, err, len(store.parts), store.completed)
	}
}
