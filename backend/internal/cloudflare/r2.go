package cloudflare

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Zone struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
}
type Bucket struct {
	Name         string `json:"name"`
	Jurisdiction string `json:"jurisdiction,omitempty"`
	CreationDate string `json:"creation_date,omitempty"`
	Location     string `json:"location,omitempty"`
}
type Domain struct {
	Domain  string `json:"domain"`
	Enabled bool   `json:"enabled"`
	ZoneID  string `json:"zoneId,omitempty"`
	Status  any    `json:"status,omitempty"`
}
type BucketPage struct {
	Buckets []Bucket `json:"buckets"`
	Cursor  string   `json:"cursor,omitempty"`
}

func (c *Client) ListAccounts(ctx context.Context, bearer string) ([]Account, error) {
	var result []Account
	err := listPages(ctx, c, bearer, "/accounts", url.Values{}, &result)
	return result, err
}

func (c *Client) ListZones(ctx context.Context, bearer, accountID string) ([]Zone, error) {
	if err := validateID(accountID, "account ID"); err != nil {
		return nil, err
	}
	var result []Zone
	q := url.Values{"account.id": {accountID}}
	err := listPages(ctx, c, bearer, "/zones", q, &result)
	return result, err
}

func (c *Client) ListBuckets(ctx context.Context, bearer, accountID, jurisdiction, cursor string) (BucketPage, error) {
	if err := validateID(accountID, "account ID"); err != nil {
		return BucketPage{}, err
	}
	if err := validateJurisdiction(jurisdiction); err != nil {
		return BucketPage{}, err
	}
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	endpoint := "/accounts/" + url.PathEscape(accountID) + "/r2/buckets"
	var result struct {
		Buckets []Bucket `json:"buckets"`
	}
	info, err := c.request(ctx, bearer, http.MethodGet, endpoint+querySuffix(q), jurisdiction, nil, &result)
	if err != nil {
		return BucketPage{}, err
	}
	return BucketPage{Buckets: result.Buckets, Cursor: stringValue(info["cursor"])}, nil
}

func (c *Client) GetBucket(ctx context.Context, bearer, accountID, jurisdiction, bucket string) (Bucket, error) {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return Bucket{}, err
	}
	var result Bucket
	_, err := c.request(ctx, bearer, http.MethodGet, bucketPath(accountID, bucket), jurisdiction, nil, &result)
	return result, err
}

func (c *Client) CreateBucket(ctx context.Context, bearer, accountID, jurisdiction, bucket string) (Bucket, error) {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return Bucket{}, err
	}
	var result Bucket
	_, err := c.request(ctx, bearer, http.MethodPost, "/accounts/"+url.PathEscape(accountID)+"/r2/buckets", jurisdiction, map[string]string{"name": bucket}, &result)
	return result, err
}

func (c *Client) DeleteBucket(ctx context.Context, bearer, accountID, jurisdiction, bucket string) error {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return err
	}
	_, err := c.request(ctx, bearer, http.MethodDelete, bucketPath(accountID, bucket), jurisdiction, nil, nil)
	return err
}

func (c *Client) ListDomains(ctx context.Context, bearer, accountID, jurisdiction, bucket string) ([]Domain, error) {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return nil, err
	}
	var result struct {
		Domains []Domain `json:"domains"`
	}
	_, err := c.request(ctx, bearer, http.MethodGet, bucketPath(accountID, bucket)+"/domains/custom", jurisdiction, nil, &result)
	return result.Domains, err
}

func (c *Client) AttachDomain(ctx context.Context, bearer, accountID, jurisdiction, bucket, domain, zoneID string) error {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return err
	}
	if err := validateDomain(domain); err != nil {
		return err
	}
	if err := validateID(zoneID, "zone ID"); err != nil {
		return err
	}
	body := map[string]any{"domain": domain, "zoneId": zoneID, "enabled": true}
	_, err := c.request(ctx, bearer, http.MethodPost, bucketPath(accountID, bucket)+"/domains/custom", jurisdiction, body, nil)
	return err
}

func (c *Client) DetachDomain(ctx context.Context, bearer, accountID, jurisdiction, bucket, domain string) error {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return err
	}
	if err := validateDomain(domain); err != nil {
		return err
	}
	_, err := c.request(ctx, bearer, http.MethodDelete, bucketPath(accountID, bucket)+"/domains/custom/"+url.PathEscape(domain), jurisdiction, nil, nil)
	return err
}

func S3Endpoint(accountID, jurisdiction string) (string, error) {
	if err := validateID(accountID, "account ID"); err != nil {
		return "", err
	}
	if err := validateJurisdiction(jurisdiction); err != nil {
		return "", err
	}
	if jurisdiction == "default" {
		return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID), nil
	}
	return fmt.Sprintf("https://%s.%s.r2.cloudflarestorage.com", accountID, jurisdiction), nil
}

func validateBucketInputs(accountID, jurisdiction, bucket string) error {
	if err := validateID(accountID, "account ID"); err != nil {
		return err
	}
	if err := validateJurisdiction(jurisdiction); err != nil {
		return err
	}
	return validateBucketName(bucket)
}

func bucketPath(accountID, bucket string) string {
	return "/accounts/" + url.PathEscape(accountID) + "/r2/buckets/" + url.PathEscape(bucket)
}
func querySuffix(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}
func stringValue(value any) string {
	if result, ok := value.(string); ok {
		return strings.TrimSpace(result)
	}
	return ""
}
