package commander

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPageSize = 100
	maxResponseSize = 4 << 20
)

type Client struct {
	baseURL   string
	managerID string
	password  string
	http      *http.Client
}

type APIError struct {
	StatusCode int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("Commander request failed (status %d)", e.StatusCode)
}

type Resource struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Manager   string `json:"manager"`
	External  bool   `json:"external"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type ResourceConfig struct {
	ID                 string         `json:"id"`
	Name               string         `json:"name"`
	Type               string         `json:"type"`
	Manager            string         `json:"manager"`
	Metadata           map[string]any `json:"metadata"`
	PlatformConnection any            `json:"platform_connection,omitempty"`
}

type ResourceDetail struct {
	Resource Resource       `json:"resource"`
	Config   ResourceConfig `json:"config"`
}

type Connection struct {
	ID        string            `json:"id"`
	Manager   string            `json:"manager"`
	Resource  string            `json:"resource"`
	External  bool              `json:"external"`
	CreatedAt string            `json:"created_at"`
	UpdatedAt string            `json:"updated_at"`
	Labels    map[string]string `json:"labels,omitempty"`
}

type ConnectionConfig struct {
	ID       string         `json:"id"`
	Manager  string         `json:"manager"`
	Resource string         `json:"resource"`
	Metadata map[string]any `json:"metadata"`
}

type ConnectionDetail struct {
	Connection Connection       `json:"connection"`
	Config     ConnectionConfig `json:"config"`
}

type ResourceCreate struct {
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	External bool           `json:"external"`
	Metadata map[string]any `json:"metadata"`
}

type ConnectionCreate struct {
	ManagerID  string            `json:"connect_manager_id"`
	ResourceID string            `json:"resource_id"`
	External   bool              `json:"external"`
	Metadata   map[string]any    `json:"metadata"`
	Labels     map[string]string `json:"labels,omitempty"`
}

type managerResponse struct {
	ID string `json:"id"`
}

type resourcePage struct {
	Items  []Resource `json:"items"`
	Limit  int        `json:"limit"`
	Offset int        `json:"offset"`
	Total  int        `json:"total"`
}

type connectionPage struct {
	Items  []Connection `json:"items"`
	Limit  int          `json:"limit"`
	Offset int          `json:"offset"`
	Total  int          `json:"total"`
}

type QueryResult struct {
	Statement int             `json:"statement"`
	Status    string          `json:"status"`
	Result    json.RawMessage `json:"result"`
}

const (
	DatabaseQueryResultsMissing  DatabaseQueryErrorKind = "results_missing"
	DatabaseQueryStatementFailed DatabaseQueryErrorKind = "statement_failed"
	DatabaseQueryResultInvalid   DatabaseQueryErrorKind = "result_invalid"
)

type DatabaseQueryErrorKind string

type DatabaseQueryError struct {
	Kind      DatabaseQueryErrorKind
	Statement int
}

func (e *DatabaseQueryError) Error() string {
	if e.Statement >= 0 {
		return fmt.Sprintf("Commander database returned an unsuccessful result (kind %s, statement %d)", e.Kind, e.Statement)
	}
	return fmt.Sprintf("Commander database returned an unsuccessful result (kind %s)", e.Kind)
}

type databaseQueryResult struct {
	Statement *int            `json:"statement"`
	Status    string          `json:"status"`
	Result    json.RawMessage `json:"result"`
}

type databaseQueryResponse struct {
	Results []databaseQueryResult `json:"results"`
}

// NewClient creates an authenticated client for the manager API base URL,
// including its /api/v1 path.
func NewClient(baseURL, managerID, password string, httpClient *http.Client) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Commander API URL must be an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	if strings.TrimSpace(managerID) == "" || password == "" {
		return nil, errors.New("Commander manager credentials are required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 12 * time.Second}
	}
	return &Client{baseURL: baseURL, managerID: managerID, password: password, http: httpClient}, nil
}

func (c *Client) VerifyManager(ctx context.Context) error {
	var response managerResponse
	if err := c.request(ctx, http.MethodGet, "/manager", nil, &response); err != nil {
		return err
	}
	if response.ID != c.managerID {
		return errors.New("Commander credentials resolved to a different manager identity")
	}
	return nil
}

func (c *Client) ListMyResources(ctx context.Context, resourceType string) ([]Resource, error) {
	items := make([]Resource, 0)
	for offset := 0; ; {
		query := url.Values{"type": {resourceType}, "limit": {strconv.Itoa(defaultPageSize)}, "offset": {strconv.Itoa(offset)}}
		var page resourcePage
		if err := c.request(ctx, http.MethodGet, "/resources/mine?"+query.Encode(), nil, &page); err != nil {
			return nil, err
		}
		if page.Total < 0 || len(page.Items) == 0 && offset < page.Total {
			return nil, errors.New("Commander returned an invalid resource page")
		}
		for _, item := range page.Items {
			if item.Manager != c.managerID || resourceType != "" && item.Type != resourceType {
				return nil, errors.New("Commander returned a resource outside the authenticated manager scope")
			}
		}
		items = append(items, page.Items...)
		offset += len(page.Items)
		if offset >= page.Total {
			return items, nil
		}
	}
}

func (c *Client) GetResource(ctx context.Context, id string) (ResourceDetail, error) {
	var detail ResourceDetail
	if err := c.request(ctx, http.MethodGet, "/resources/"+escapePathComponent(id), nil, &detail); err != nil {
		return ResourceDetail{}, err
	}
	if detail.Resource.ID != id || detail.Resource.Manager != c.managerID {
		return ResourceDetail{}, errors.New("Commander returned a resource outside the authenticated manager scope")
	}
	if detail.Config.ID == "" {
		detail.Config.ID = detail.Resource.ID
	}
	if detail.Config.Manager == "" {
		detail.Config.Manager = detail.Resource.Manager
	}
	return detail, nil
}

func (c *Client) CreateResource(ctx context.Context, input ResourceCreate) (ResourceDetail, error) {
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Type) == "" {
		return ResourceDetail{}, errors.New("resource name and type are required")
	}
	body := map[string]any{
		"name": input.Name, "type": input.Type, "external": input.External,
		"config": map[string]any{"metadata": input.Metadata},
	}
	var detail ResourceDetail
	if err := c.request(ctx, http.MethodPost, "/resources", body, &detail); err != nil {
		return ResourceDetail{}, err
	}
	if detail.Resource.ID == "" || detail.Resource.Manager != c.managerID {
		return ResourceDetail{}, errors.New("Commander created a resource outside the authenticated manager scope")
	}
	return detail, nil
}

func (c *Client) ListConnections(ctx context.Context, resourceID string) ([]Connection, error) {
	if err := validateID(resourceID); err != nil {
		return nil, err
	}
	items := make([]Connection, 0)
	for offset := 0; ; {
		query := url.Values{"resource": {resourceID}, "include_labels": {"true"}, "limit": {strconv.Itoa(defaultPageSize)}, "offset": {strconv.Itoa(offset)}}
		var page connectionPage
		if err := c.request(ctx, http.MethodGet, "/connections?"+query.Encode(), nil, &page); err != nil {
			return nil, err
		}
		if page.Total < 0 || len(page.Items) == 0 && offset < page.Total {
			return nil, errors.New("Commander returned an invalid connection page")
		}
		for _, item := range page.Items {
			if item.Resource != resourceID {
				return nil, errors.New("Commander returned a connection attached to a different resource")
			}
		}
		items = append(items, page.Items...)
		offset += len(page.Items)
		if offset >= page.Total {
			return items, nil
		}
	}
}

func (c *Client) GetConnection(ctx context.Context, id string) (ConnectionDetail, error) {
	if err := validateID(id); err != nil {
		return ConnectionDetail{}, err
	}
	var detail ConnectionDetail
	if err := c.request(ctx, http.MethodGet, "/connections/"+escapePathComponent(id)+"?include_labels=true", nil, &detail); err != nil {
		return ConnectionDetail{}, err
	}
	if detail.Connection.ID != id || detail.Config.Manager != "" && detail.Config.Manager != detail.Connection.Manager || detail.Config.Resource != "" && detail.Config.Resource != detail.Connection.Resource {
		return ConnectionDetail{}, errors.New("Commander returned inconsistent connection identity")
	}
	if detail.Config.ID == "" {
		detail.Config.ID = detail.Connection.ID
	}
	if detail.Config.Manager == "" {
		detail.Config.Manager = detail.Connection.Manager
	}
	if detail.Config.Resource == "" {
		detail.Config.Resource = detail.Connection.Resource
	}
	return detail, nil
}

func (c *Client) CreateConnection(ctx context.Context, input ConnectionCreate) (ConnectionDetail, error) {
	if err := validateID(input.ManagerID); err != nil {
		return ConnectionDetail{}, errors.New("beneficiary manager ID is invalid")
	}
	if err := validateID(input.ResourceID); err != nil {
		return ConnectionDetail{}, errors.New("resource ID is invalid")
	}
	body := map[string]any{
		"connect_manager_id": input.ManagerID,
		"resource_id":        input.ResourceID,
		"external":           input.External,
		"config":             map[string]any{"metadata": input.Metadata},
	}
	if len(input.Labels) > 0 {
		body["labels"] = input.Labels
	}
	var detail ConnectionDetail
	if err := c.request(ctx, http.MethodPost, "/connections", body, &detail); err != nil {
		return ConnectionDetail{}, err
	}
	if detail.Connection.ID == "" || detail.Connection.Resource != input.ResourceID || detail.Connection.Manager != input.ManagerID {
		return ConnectionDetail{}, errors.New("Commander created a connection with unexpected identity")
	}
	return detail, nil
}

func (c *Client) UpdateConnection(ctx context.Context, id string, metadata any) error {
	if err := validateID(id); err != nil {
		return err
	}
	return c.request(ctx, http.MethodPatch, "/connections/"+escapePathComponent(id), map[string]any{"metadata": metadata}, nil)
}

func (c *Client) DeleteConnection(ctx context.Context, id string) error {
	if err := validateID(id); err != nil {
		return err
	}
	return c.request(ctx, http.MethodDelete, "/connections/"+escapePathComponent(id), nil, nil)
}

func (c *Client) PutConnectionLabel(ctx context.Context, id, key, value string) error {
	if err := validateID(id); err != nil {
		return err
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("connection label key is required")
	}
	return c.request(ctx, http.MethodPut, "/connections/"+escapePathComponent(id)+"/labels/"+escapePathComponent(key), map[string]string{"value": value}, nil)
}

func (c *Client) DeleteConnectionLabel(ctx context.Context, id, key string) error {
	if err := validateID(id); err != nil {
		return err
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("connection label key is required")
	}
	return c.request(ctx, http.MethodDelete, "/connections/"+escapePathComponent(id)+"/labels/"+escapePathComponent(key), nil, nil)
}

func (c *Client) DatabaseQuery(ctx context.Context, query string, bindings map[string]any) ([]QueryResult, error) {
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("database query is required")
	}
	body := map[string]any{"query": query}
	if bindings != nil {
		body["bindings"] = bindings
	}
	var response databaseQueryResponse
	if err := c.request(ctx, http.MethodPost, "/database/query", body, &response); err != nil {
		return nil, err
	}
	if len(response.Results) == 0 {
		return nil, &DatabaseQueryError{Kind: DatabaseQueryResultsMissing, Statement: -1}
	}
	results := make([]QueryResult, len(response.Results))
	for i, result := range response.Results {
		if result.Status != "" && result.Status != "OK" {
			return nil, &DatabaseQueryError{Kind: DatabaseQueryStatementFailed, Statement: i}
		}
		if result.Status != "OK" || result.Statement == nil || *result.Statement != i || len(result.Result) == 0 {
			return nil, &DatabaseQueryError{Kind: DatabaseQueryResultInvalid, Statement: i}
		}
		results[i] = QueryResult{Statement: *result.Statement, Status: result.Status, Result: result.Result}
	}
	return results, nil
}

func (c *Client) request(ctx context.Context, method, suffix string, body, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return errors.New("Commander request could not be encoded")
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+suffix, reader)
	if err != nil {
		return errors.New("Commander request could not be created")
	}
	req.SetBasicAuth(c.managerID, c.password)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New("Commander service is unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusNoContent || output == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize+1))
	if err != nil || len(data) > maxResponseSize {
		return errors.New("Commander response is invalid")
	}
	if err := json.Unmarshal(data, output); err != nil {
		return errors.New("Commander response is invalid")
	}
	return nil
}

func escapePathComponent(value string) string {
	return url.PathEscape(value)
}

func validateID(value string) error {
	if len(value) == 0 || len(value) > 128 {
		return errors.New("Commander ID is invalid")
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return errors.New("Commander ID is invalid")
		}
	}
	return nil
}
