package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
)

var testCreds = credentials.NewStaticCredentialsProvider("AKIDEXAMPLE", "secret", "token")

func TestConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/agent/config" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") ||
			!strings.Contains(auth, "/us-west-2/execute-api/aws4_request") {
			t.Errorf("request not SigV4-signed for execute-api: %q", auth)
		}
		if r.Header.Get("X-Amz-Security-Token") != "token" {
			t.Error("missing session token")
		}
		_, _ = io.WriteString(w, `{"serverId":"s1","game":"minecraft-java","version":"1.21.4","image":"img","port":25565}`)
	}))
	defer srv.Close()

	cfg, err := New(srv.URL+"/", "us-west-2", testCreds).Config(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerID != "s1" || cfg.Game != "minecraft-java" || cfg.Version != "1.21.4" || cfg.Image != "img" || cfg.Port != 25565 {
		t.Errorf("config %+v", cfg)
	}
}

func TestReportStatus(t *testing.T) {
	var got StatusReport
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/agent/status" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Error("missing content type")
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	err := New(srv.URL, "us-west-2", testCreds).ReportStatus(context.Background(), StatusReport{State: "ready", AgentVersion: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if got != (StatusReport{State: "ready", AgentVersion: "0.1.0"}) {
		t.Errorf("sent %+v", got)
	}
}

func TestBackupRoutes(t *testing.T) {
	var done map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /agent/backup-credentials":
			_, _ = io.WriteString(w, `{"bucket":"b","key":"servers/s1/20261004T120000Z.tar.gz","region":"us-west-2",`+
				`"credentials":{"accessKeyId":"AKID","secretAccessKey":"s","sessionToken":"t","expiration":"2026-10-04T12:15:00.000Z"}}`)
		case "POST /agent/backups", "POST /agent/restored":
			_ = json.NewDecoder(r.Body).Decode(&done)
			done["path"] = r.URL.Path
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "us-west-2", testCreds)

	target, err := c.BackupCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if target.Bucket != "b" || target.Key != "servers/s1/20261004T120000Z.tar.gz" || target.Region != "us-west-2" ||
		target.Credentials.SessionToken != "t" || target.Credentials.Expiration.Minute() != 15 {
		t.Errorf("target %+v", target)
	}
	if err := c.BackupDone(context.Background(), target.Key); err != nil {
		t.Fatal(err)
	}
	if done["key"] != target.Key || done["path"] != "/agent/backups" {
		t.Errorf("sent %v", done)
	}
	if err := c.Restored(context.Background(), target.Key); err != nil {
		t.Fatal(err)
	}
	if done["key"] != target.Key || done["path"] != "/agent/restored" {
		t.Errorf("sent %v", done)
	}
}

func TestIdle(t *testing.T) {
	var got map[string]int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/agent/idle" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	if err := New(srv.URL, "us-west-2", testCreds).Idle(context.Background(), 30); err != nil {
		t.Fatal(err)
	}
	if got["idleMinutes"] != 30 {
		t.Errorf("sent %v", got)
	}
}

func TestErrorResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"No server is assigned to instance i-1"}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL, "us-west-2", testCreds).Config(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 404 || !strings.Contains(apiErr.Body, "No server") {
		t.Errorf("error %v", err)
	}
}

func TestCredentialsFailure(t *testing.T) {
	failing := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{}, errors.New("no IMDS")
	})
	if _, err := New("http://127.0.0.1:1", "us-west-2", failing).Config(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "credentials") {
		t.Errorf("error %v", err)
	}
}
