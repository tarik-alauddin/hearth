// Package api calls the Hearth API's agent routes, signed with the instance role (SigV4).
package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// StatusReport mirrors AgentStatusReport in packages/shared.
type StatusReport struct {
	State        string `json:"state"` // starting, ready, stopping, stopped or error
	AgentVersion string `json:"agentVersion"`
	Message      string `json:"message,omitempty"`
}

// Error is a non-2xx response.
type Error struct {
	Status int
	Body   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("API returned %d: %s", e.Status, e.Body)
}

type Client struct {
	baseURL     string
	region      string
	credentials aws.CredentialsProvider
	signer      *v4.Signer
	http        *http.Client
}

// New creates a client for the API at baseURL in region, signing with credentials.
func New(baseURL, region string, credentials aws.CredentialsProvider) *Client {
	return &Client{
		baseURL:     strings.TrimSuffix(baseURL, "/"),
		region:      region,
		credentials: credentials,
		signer:      v4.NewSigner(),
		http:        &http.Client{Timeout: 15 * time.Second},
	}
}

// Config returns this instance's server config (GET /agent/config).
func (c *Client) Config(ctx context.Context) (game.Config, error) {
	var cfg game.Config
	err := c.do(ctx, http.MethodGet, "/agent/config", nil, &cfg)
	return cfg, err
}

// ReportStatus records the agent's state (POST /agent/status).
func (c *Client) ReportStatus(ctx context.Context, report StatusReport) error {
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, "/agent/status", body, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	creds, err := c.credentials.Retrieve(ctx)
	if err != nil {
		return fmt.Errorf("credentials: %w", err)
	}
	hash := sha256.Sum256(body)
	if err := c.signer.SignHTTP(ctx, creds, req, hex.EncodeToString(hash[:]), "execute-api", c.region, time.Now()); err != nil {
		return fmt.Errorf("sign: %w", err)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &Error{Status: resp.StatusCode, Body: strings.TrimSpace(string(respBody))}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("decode %s response: %w", path, err)
	}
	return nil
}
