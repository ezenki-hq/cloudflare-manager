package cloudflare

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const credentialNamePrefix = "deploy-commander-cloudflare/"

type Credential struct {
	TokenID         string `json:"token_id"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
}

type permissionGroup struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Selectable bool     `json:"is_selectable"`
	Scopes     []string `json:"scopes"`
}

type accountToken struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (c *Client) CreateCredential(ctx context.Context, bearer, accountID, jurisdiction, bucket, connectionID, permission string) (Credential, error) {
	if err := validateBucketInputs(accountID, jurisdiction, bucket); err != nil {
		return Credential{}, err
	}
	if err := validateID(connectionID, "connection ID"); err != nil {
		return Credential{}, err
	}
	groupName := ""
	switch permission {
	case "read-only":
		groupName = "Workers R2 Storage Bucket Item Read"
	case "read-write":
		groupName = "Workers R2 Storage Bucket Item Write"
	default:
		return Credential{}, errors.New("permission must be read-only or read-write")
	}

	var groups []permissionGroup
	q := url.Values{"name": {groupName}, "scope": {"com.cloudflare.edge.r2.bucket"}}
	_, err := c.request(ctx, bearer, http.MethodGet, "/accounts/"+url.PathEscape(accountID)+"/tokens/permission_groups?"+q.Encode(), "", nil, &groups)
	if err != nil {
		return Credential{}, err
	}
	var group *permissionGroup
	for i := range groups {
		if groups[i].Name == groupName && groups[i].Selectable && contains(groups[i].Scopes, "com.cloudflare.edge.r2.bucket") {
			group = &groups[i]
			break
		}
	}
	if group == nil || group.ID == "" {
		return Credential{}, errors.New("Cloudflare does not offer the required bucket permission")
	}

	resource := fmt.Sprintf("com.cloudflare.edge.r2.bucket.%s_%s_%s", accountID, jurisdiction, bucket)
	body := map[string]any{
		"name": credentialNamePrefix + connectionID,
		"policies": []any{map[string]any{
			"effect":            "allow",
			"permission_groups": []any{map[string]string{"id": group.ID}},
			"resources":         map[string]string{resource: "*"},
		}},
	}
	var created struct {
		ID    string `json:"id"`
		Value string `json:"value"`
	}
	_, err = c.request(ctx, bearer, http.MethodPost, "/accounts/"+url.PathEscape(accountID)+"/tokens", "", body, &created)
	if err != nil {
		return Credential{}, err
	}
	if created.ID == "" || created.Value == "" {
		return Credential{}, errors.New("Cloudflare created an incomplete API token")
	}
	hash := sha256.Sum256([]byte(created.Value))
	return Credential{TokenID: created.ID, AccessKeyID: created.ID, SecretAccessKey: hex.EncodeToString(hash[:])}, nil
}

func (c *Client) FindCredential(ctx context.Context, bearer, accountID, connectionID string) (string, error) {
	if err := validateID(accountID, "account ID"); err != nil {
		return "", err
	}
	if err := validateID(connectionID, "connection ID"); err != nil {
		return "", err
	}
	var tokens []accountToken
	if err := listPages(ctx, c, bearer, "/accounts/"+url.PathEscape(accountID)+"/tokens", url.Values{}, &tokens); err != nil {
		return "", err
	}
	wantName := credentialNamePrefix + connectionID
	found := ""
	for _, token := range tokens {
		if token.Name == wantName {
			if found != "" {
				return "", errors.New("multiple Cloudflare credentials match this connection")
			}
			found = token.ID
		}
	}
	return found, nil
}

func (c *Client) RevokeCredential(ctx context.Context, bearer, accountID, tokenID, connectionID string) error {
	if err := validateID(accountID, "account ID"); err != nil {
		return err
	}
	if err := validateID(tokenID, "token ID"); err != nil {
		return err
	}
	if err := validateID(connectionID, "connection ID"); err != nil {
		return err
	}
	var token accountToken
	_, err := c.request(ctx, bearer, http.MethodGet, "/accounts/"+url.PathEscape(accountID)+"/tokens/"+url.PathEscape(tokenID), "", nil, &token)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		// A previous cleanup attempt may have deleted the token before the
		// Deploy Commander record was removed. Treat that state as revoked.
		return nil
	}
	if err != nil {
		return err
	}
	if token.ID != tokenID || token.Name != credentialNamePrefix+connectionID {
		return errors.New("refusing to revoke a Cloudflare token not owned by this connection")
	}
	_, err = c.request(ctx, bearer, http.MethodDelete, "/accounts/"+url.PathEscape(accountID)+"/tokens/"+url.PathEscape(tokenID), "", nil, nil)
	return err
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(value, target) {
			return true
		}
	}
	return false
}
