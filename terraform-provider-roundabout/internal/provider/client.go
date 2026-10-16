package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a minimal Roundabout admin API client.
type Client struct {
	Endpoint string
	APIKey   string
	HTTP     *http.Client
}

func NewClient(endpoint, apiKey string, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{Endpoint: strings.TrimRight(endpoint, "/"), APIKey: apiKey, HTTP: hc}
}

type Site struct {
	ID                      string   `json:"id"`
	Name                    string   `json:"name"`
	Sitekey                 string   `json:"sitekey"`
	Domains                 []string `json:"domains"`
	Mode                    string   `json:"mode"`
	Difficulty              int64    `json:"difficulty"`
	ClearanceEnabled        bool     `json:"clearance_enabled"`
	ClearanceTTLSecs        int64    `json:"clearance_ttl_secs"`
	CreatedAt               string   `json:"created_at"`
	UpdatedAt               string   `json:"updated_at"`
	PreviousSecretExpiresAt *string  `json:"previous_secret_expires_at"`
}

type SiteInput struct {
	Name             string   `json:"name"`
	Domains          []string `json:"domains"`
	Mode             string   `json:"mode"`
	Difficulty       int64    `json:"difficulty"`
	ClearanceEnabled bool     `json:"clearance_enabled"`
	ClearanceTTLSecs int64    `json:"clearance_ttl_secs"`
}

type SiteUpdate struct {
	Name       *string  `json:"name,omitempty"`
	Domains    []string `json:"domains,omitempty"`
	Mode       *string  `json:"mode,omitempty"`
	Difficulty *int64   `json:"difficulty,omitempty"`

	ClearanceEnabled *bool  `json:"clearance_enabled,omitempty"`
	ClearanceTTLSecs *int64 `json:"clearance_ttl_secs,omitempty"`
}

// APIError is a non-2xx response from the API.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("roundabout API error (HTTP %d): %s", e.Status, e.Message)
}

func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reqBody io.Reader
	// The API rejects non-GET requests without a JSON body (CSRF guard), so
	// always send one.
	if method != http.MethodGet {
		if body == nil {
			body = struct{}{}
		}
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Endpoint+path, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}

	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return &APIError{Status: res.StatusCode, Message: msg}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decoding response: %w", err)
		}
	}
	return nil
}

func sitePath(id string) string {
	return "/api/sites/" + url.PathEscape(id)
}

func (c *Client) CreateSite(ctx context.Context, in SiteInput) (*Site, string, error) {
	var out struct {
		Site   Site   `json:"site"`
		Secret string `json:"secret"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/sites", in, &out); err != nil {
		return nil, "", err
	}
	return &out.Site, out.Secret, nil
}

func (c *Client) GetSite(ctx context.Context, id string) (*Site, error) {
	var s Site
	if err := c.do(ctx, http.MethodGet, sitePath(id), nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (c *Client) ListSites(ctx context.Context) ([]Site, error) {
	var s []Site
	if err := c.do(ctx, http.MethodGet, "/api/sites", nil, &s); err != nil {
		return nil, err
	}
	return s, nil
}

func (c *Client) UpdateSite(ctx context.Context, id string, in SiteUpdate) (*Site, error) {
	var s Site
	if err := c.do(ctx, http.MethodPatch, sitePath(id), in, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (c *Client) DeleteSite(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, sitePath(id), nil, nil)
}

type RotatedSecret struct {
	Secret                  string  `json:"secret"`
	PreviousSecretExpiresAt *string `json:"previous_secret_expires_at"`
}

func (c *Client) RotateSecret(ctx context.Context, id string, graceHours int64) (*RotatedSecret, error) {
	var out RotatedSecret
	body := map[string]int64{"grace_hours": graceHours}
	if err := c.do(ctx, http.MethodPost, sitePath(id)+"/rotate-secret", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
