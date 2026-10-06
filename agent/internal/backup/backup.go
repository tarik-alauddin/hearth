// Package backup archives a game's data and uploads it to the backup bucket, with credentials the
// API hands out for that one upload. The archive is streamed: nothing is staged on disk.
package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// API is the Hearth API's backup routes.
type API interface {
	BackupCredentials(ctx context.Context) (api.BackupTarget, error)
	BackupDone(ctx context.Context, key string) error
}

// S3 is the part of the S3 client a multipart upload uses.
type S3 interface {
	CreateMultipartUpload(ctx context.Context, in *s3.CreateMultipartUploadInput, opts ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error)
	UploadPart(ctx context.Context, in *s3.UploadPartInput, opts ...func(*s3.Options)) (*s3.UploadPartOutput, error)
	CompleteMultipartUpload(ctx context.Context, in *s3.CompleteMultipartUploadInput, opts ...func(*s3.Options)) (*s3.CompleteMultipartUploadOutput, error)
	AbortMultipartUpload(ctx context.Context, in *s3.AbortMultipartUploadInput, opts ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error)
}

// DefaultPartSize keeps one part in memory at a time; S3's 10,000-part limit allows 160 GiB.
const DefaultPartSize = 16 << 20

const maxParts = 10000

// Result is a finished backup.
type Result struct {
	Key   string
	Bytes int64
}

type Backuper struct {
	API API
	// NewS3 returns an S3 client for the target's region, signing with its credentials.
	NewS3 func(target api.BackupTarget) S3
	// PartSize defaults to DefaultPartSize.
	PartSize int
}

// Backup archives spec, uploads it to a new key and records it with the API.
func (b *Backuper) Backup(ctx context.Context, spec game.BackupSpec) (Result, error) {
	if _, err := os.Stat(spec.Dir); err != nil {
		return Result{}, fmt.Errorf("nothing to back up: %w", err)
	}
	target, err := b.API.BackupCredentials(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("get backup credentials: %w", err)
	}

	pr, pw := io.Pipe()
	archived := make(chan struct{})
	go func() {
		defer close(archived)
		pw.CloseWithError(Archive(pw, spec)) // nil closes normally
	}()
	partSize := b.PartSize
	if partSize == 0 {
		partSize = DefaultPartSize
	}
	// An archive error reaches the upload through the pipe, so err covers both.
	n, err := upload(ctx, b.NewS3(target), target.Bucket, target.Key, pr, partSize)
	pr.CloseWithError(errors.New("upload ended")) // unblocks the archiver if the upload failed
	<-archived
	if err != nil {
		return Result{}, fmt.Errorf("upload %s: %w", target.Key, err)
	}

	if err := b.API.BackupDone(ctx, target.Key); err != nil {
		return Result{}, fmt.Errorf("record backup: %w", err)
	}
	return Result{Key: target.Key, Bytes: n}, nil
}

// Archive writes spec as a gzipped tar, with paths relative to spec.Dir. It keeps directories,
// regular files and symlinks, with their modes and owners; anything else (sockets, pipes) is skipped.
func Archive(w io.Writer, spec game.BackupSpec) error {
	// Fastest compression: the upload is on the clock, and game data is often compressed already.
	gz, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)
	walkErr := filepath.WalkDir(spec.Dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(spec.Dir, p)
		if err != nil || rel == "." {
			return err
		}
		name := filepath.ToSlash(rel)
		if spec.Excludes(name) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		return addFile(tw, p, name, d)
	})
	return errors.Join(walkErr, tw.Close(), gz.Close())
}

func addFile(tw *tar.Writer, p, name string, d fs.DirEntry) error {
	info, err := d.Info()
	if err != nil {
		return err
	}
	link := ""
	switch mode := info.Mode(); {
	case mode&fs.ModeSymlink != 0:
		if link, err = os.Readlink(p); err != nil {
			return err
		}
	case !mode.IsRegular() && !mode.IsDir():
		return nil
	}
	hdr, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return err
	}
	hdr.Name = name
	if info.IsDir() {
		hdr.Name += "/"
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}

// upload streams r to bucket/key as a multipart upload, one part in memory at a time, and returns
// the bytes uploaded. A failed upload is aborted, so no partial object is left behind.
func upload(ctx context.Context, client S3, bucket, key string, r io.Reader, partSize int) (int64, error) {
	created, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:            &bucket,
		Key:               &key,
		ContentType:       aws.String("application/gzip"),
		ChecksumAlgorithm: types.ChecksumAlgorithmCrc32,
	})
	if err != nil {
		return 0, err
	}
	abort := func(cause error) (int64, error) {
		// ctx may be what ran out; aborting still needs a moment.
		abortCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_, abortErr := client.AbortMultipartUpload(abortCtx, &s3.AbortMultipartUploadInput{
			Bucket: &bucket, Key: &key, UploadId: created.UploadId,
		})
		return 0, errors.Join(cause, abortErr)
	}

	var parts []types.CompletedPart
	var total int64
	buf := make([]byte, partSize)
	for number := int32(1); ; number++ {
		size, readErr := io.ReadFull(r, buf)
		last := errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF)
		if readErr != nil && !last {
			return abort(readErr)
		}
		if size > 0 || number == 1 {
			if number > maxParts {
				return abort(fmt.Errorf("backup is larger than %d parts of %d bytes", maxParts, partSize))
			}
			out, err := client.UploadPart(ctx, &s3.UploadPartInput{
				Bucket:            &bucket,
				Key:               &key,
				UploadId:          created.UploadId,
				PartNumber:        aws.Int32(number),
				Body:              bytes.NewReader(buf[:size]),
				ChecksumAlgorithm: types.ChecksumAlgorithmCrc32,
			})
			if err != nil {
				return abort(fmt.Errorf("part %d: %w", number, err))
			}
			parts = append(parts, types.CompletedPart{
				ETag:          out.ETag,
				PartNumber:    aws.Int32(number),
				ChecksumCRC32: out.ChecksumCRC32,
			})
			total += int64(size)
		}
		if last {
			break
		}
	}

	_, err = client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          &bucket,
		Key:             &key,
		UploadId:        created.UploadId,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	})
	if err != nil {
		return abort(err)
	}
	return total, nil
}
