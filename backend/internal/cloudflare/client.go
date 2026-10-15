package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	apiPrefix       = "/client/v4"
	maxResponse     = 4 << 20
	maxListPages    = 100
	defaultPageSize = 50
)

var safeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type Client struct {
	baseURL *url.URL
	http    *http.Client
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("Cloudflare API returned status %d", e.Status)
	}
	return fmt.Sprintf("Cloudflare API: %s (status %d)", e.Message, e.Status)
}

func NewClient(baseURL string, httpClient *http.Client) *Client {
	parsed, _ := url.Parse(strings.TrimRight(baseURL, "/"))
	if parsed == nil || parsed.Scheme == "" || parsed.Host == "" {
		parsed, _ = url.Parse("https://api.cloudflare.com")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{baseURL: parsed, http: httpClient}
}

type apiEnvelope struct {
	Success    bool            `json:"success"`
	Result     json.RawMessage `json:"result"`
	ResultInfo map[string]any  `json:"result_info"`
	Errors     []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func (c *Client) request(ctx context.Context, bearer, method, endpoint, jurisdiction string, body any, out any) (map[string]any, error) {
	if strings.TrimSpace(bearer) == "" {
		return nil, errors.New("Cloudflare authorization is required")
	}
	if jurisdiction != "" {
		if err := validateJurisdiction(jurisdiction); err != nil {
			return nil, err
		}
	}
	target := *c.baseURL
	relative, parseErr := url.Parse(endpoint)
	if parseErr != nil {
		return nil, errors.New("invalid Cloudflare API path")
	}
	target.Path = strings.TrimRight(c.baseURL.Path, "/") + apiPrefix + relative.Path
	target.RawPath = ""
	target.RawQuery = relative.RawQuery
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, errors.New("could not encode Cloudflare request")
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return nil, errors.New("invalid Cloudflare request")
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if jurisdiction != "" {
		req.Header.Set("cf-r2-jurisdiction", jurisdiction)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New("Cloudflare API request failed")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		return nil, errors.New("Cloudflare API response was invalid or too large")
	}
	var envelope apiEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("Cloudflare API returned an invalid response (status %d)", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !envelope.Success {
		message := "request failed"
		if len(envelope.Errors) > 0 && strings.TrimSpace(envelope.Errors[0].Message) != "" {
			message = envelope.Errors[0].Message
		}
		return nil, &APIError{Status: resp.StatusCode, Message: message}
	}
	if out != nil && len(envelope.Result) != 0 && string(envelope.Result) != "null" {
		if err := json.Unmarshal(envelope.Result, out); err != nil {
			return nil, errors.New("Cloudflare API returned an invalid result")
		}
	}
	return envelope.ResultInfo, nil
}

func validateID(value, label string) error {
	if !safeIDPattern.MatchString(value) {
		return fmt.Errorf("invalid %s", label)
	}
	return nil
}

func validateBucketName(value string) error {
	if len(value) < 3 || len(value) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).MatchString(value) {
		return errors.New("invalid bucket name")
	}
	return nil
}

func validateDomain(value string) error {
	if len(value) > 253 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "/:@?# ") {
		return errors.New("invalid domain")
	}
	for _, label := range strings.Split(strings.TrimSuffix(value, "."), ".") {
		if len(label) == 0 || len(label) > 63 || !regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`).MatchString(label) {
			return errors.New("invalid domain")
		}
	}
	return nil
}

func validateJurisdiction(value string) error {
	switch value {
	case "default", "eu", "us", "fedramp", "fedramp-high":
		return nil
	}
	return errors.New("invalid R2 jurisdiction")
}

func listPages[T any](ctx context.Context, c *Client, bearer, endpoint string, query url.Values, destination *[]T) error {
	for page := 1; page <= maxListPages; page++ {
		q := url.Values{}
		for key, values := range query {
			for _, value := range values {
				q.Add(key, value)
			}
		}
		q.Set("page", fmt.Sprint(page))
		q.Set("per_page", fmt.Sprint(defaultPageSize))
		var entries []T
		info, err := c.request(ctx, bearer, http.MethodGet, endpoint+"?"+q.Encode(), "", nil, &entries)
		if err != nil {
			return err
		}
		*destination = append(*destination, entries...)
		if total := numberValue(info["total_pages"]); total > 0 {
			if page >= total {
				return nil
			}
		} else if len(entries) < defaultPageSize {
			return nil
		}
	}
	return errors.New("Cloudflare API pagination exceeded the page limit")
}

func numberValue(value any) int {
	switch n := value.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}
