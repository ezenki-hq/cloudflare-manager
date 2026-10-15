package cloudflare

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateCredentialBucketPolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/client/v4/accounts/account1/tokens/permission_groups":
			if r.URL.Query().Get("name") != "Workers R2 Storage Bucket Item Write" || r.URL.Query().Get("scope") != "com.cloudflare.edge.r2.bucket" {
				t.Errorf("permission lookup query=%q", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"write-group","name":"Workers R2 Storage Bucket Item Write","is_selectable":true,"scopes":["com.cloudflare.edge.r2.bucket"]}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/client/v4/accounts/account1/tokens":
			var body struct {
				Name     string `json:"name"`
				Policies []struct {
					Effect           string `json:"effect"`
					PermissionGroups []struct {
						ID string `json:"id"`
					} `json:"permission_groups"`
					Resources map[string]string `json:"resources"`
				} `json:"policies"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Name != "deploy-commander-cloudflare/conn-123" || len(body.Policies) != 1 || body.Policies[0].Effect != "allow" || len(body.Policies[0].PermissionGroups) != 1 || body.Policies[0].PermissionGroups[0].ID != "write-group" {
				t.Errorf("token request=%+v", body)
			}
			wantResource := "com.cloudflare.edge.r2.bucket.account1_eu_bucket-one"
			if len(body.Policies[0].Resources) != 1 || body.Policies[0].Resources[wantResource] != "*" {
				t.Errorf("policy resources=%v", body.Policies[0].Resources)
			}
			_, _ = w.Write([]byte(`{"success":true,"result":{"id":"token-123","value":"secret-token-value"}}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	credential, err := NewClient(server.URL, server.Client()).CreateCredential(context.Background(), "user-token", "account1", "eu", "bucket-one", "conn-123", "read-write")
	if err != nil {
		t.Fatal(err)
	}
	if credential.TokenID != "token-123" || credential.AccessKeyID != "token-123" {
		t.Fatalf("credential=%+v", credential)
	}
}

func TestS3KeyDerivation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"read-group","name":"Workers R2 Storage Bucket Item Read","is_selectable":true,"scopes":["com.cloudflare.edge.r2.bucket"]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{"id":"access-key-id","value":"opaque-cloudflare-value"}}`))
	}))
	defer server.Close()
	got, err := NewClient(server.URL, server.Client()).CreateCredential(context.Background(), "user-token", "account1", "default", "bucket-one", "conn-123", "read-only")
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte("opaque-cloudflare-value"))
	if got.AccessKeyID != "access-key-id" || got.SecretAccessKey != hex.EncodeToString(h[:]) {
		t.Fatalf("credential derivation mismatch: %+v", got)
	}
	if strings.Contains(got.SecretAccessKey, "opaque-cloudflare-value") {
		t.Fatal("returned token value instead of hash")
	}
}

func TestRevokeRejectsUnmanagedToken(t *testing.T) {
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"success":true,"result":{"id":"token-123","name":"some-other-token"}}`))
			return
		}
		if r.Method == http.MethodDelete {
			deletes++
		}
	}))
	defer server.Close()
	err := NewClient(server.URL, server.Client()).RevokeCredential(context.Background(), "user-token", "account1", "token-123", "conn-123")
	if err == nil || deletes != 0 {
		t.Fatalf("err=%v deletes=%d", err, deletes)
	}
}

func TestFindCredentialByConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/client/v4/accounts/account1/tokens" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.URL.Query().Get("page") == "1" {
			_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"other","name":"unrelated"}],"result_info":{"page":1,"total_pages":2}}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"found-token","name":"deploy-commander-cloudflare/conn-123"}],"result_info":{"page":2,"total_pages":2}}`))
	}))
	defer server.Close()
	id, err := NewClient(server.URL, server.Client()).FindCredential(context.Background(), "user-token", "account1", "conn-123")
	if err != nil || id != "found-token" {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestRevokeManagedToken(t *testing.T) {
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"success":true,"result":{"id":"token-123","name":"deploy-commander-cloudflare/conn-123"}}`))
			return
		}
		if r.Method == http.MethodDelete && r.URL.Path == "/client/v4/accounts/account1/tokens/token-123" {
			deleted = true
			_, _ = w.Write([]byte(`{"success":true,"result":{"id":"token-123"}}`))
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()
	if err := NewClient(server.URL, server.Client()).RevokeCredential(context.Background(), "user-token", "account1", "token-123", "conn-123"); err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Fatal("managed token was not deleted")
	}
}

func TestRevokeAlreadyMissingTokenIsIdempotent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"message":"not found"}]}`))
	}))
	defer server.Close()
	if err := NewClient(server.URL, server.Client()).RevokeCredential(context.Background(), "user-token", "account1", "token-123", "conn-123"); err != nil {
		t.Fatalf("repeated revoke should be safe: %v", err)
	}
}
