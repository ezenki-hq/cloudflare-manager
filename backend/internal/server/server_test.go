package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
)

const testOrigin = "https://commander.example.test"

func setup(t *testing.T, cfServer http.HandlerFunc) (http.Handler, *httptest.Server, *http.Cookie) {
	t.Helper()
	upstream := httptest.NewServer(cfServer)
	client := cloudflare.NewClient(upstream.URL, upstream.Client())
	oauth, err := auth.NewHandler(auth.Config{ClientID: "client", PublicOrigin: "https://manager.example.test", FrontendOrigin: testOrigin, AuthorizationURL: "https://cloudflare.example.test/authorize", TokenURL: "https://cloudflare.example.test/token"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{FrontendOrigin: testOrigin}, oauth, client)
	cookie := &http.Cookie{Name: "__Host-cf-access", Value: "per-user-token", Path: "/", Secure: true, HttpOnly: true}
	return h, upstream, cookie
}

func TestOriginRejectsMutation(t *testing.T) {
	called := 0
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) {
		called++
		_, _ = w.Write([]byte(`{"success":true,"result":{}}`))
	})
	defer upstream.Close()
	for _, origin := range []string{"https://attacker.example.test", ""} {
		req := httptest.NewRequest(http.MethodPost, "/api/accounts/account1/buckets", strings.NewReader(`{"name":"bucket-one","jurisdiction":"default"}`))
		req.AddCookie(cookie)
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp := httptest.NewRecorder()
		h.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Errorf("origin %q status=%d", origin, resp.Code)
		}
	}
	if called != 0 {
		t.Fatalf("upstream called %d times", called)
	}
}

func TestMissingCookieDoesNotCallCloudflare(t *testing.T) {
	called := 0
	h, upstream, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { called++ })
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized || called != 0 {
		t.Fatalf("status=%d upstream=%d", resp.Code, called)
	}
}

func TestCredentialsNeverCache(t *testing.T) {
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "permission_groups") {
			_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"group","name":"Workers R2 Storage Bucket Item Read","is_selectable":true,"scopes":["com.cloudflare.edge.r2.bucket"]}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{"id":"secret-id","value":"opaque-token-value"}}`))
	})
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/accounts/account1/buckets/bucket-one/credentials", strings.NewReader(`{"jurisdiction":"default","connection_id":"connection-1","permission":"read-only"}`))
	req.AddCookie(cookie)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if resp.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache header=%q", resp.Header().Get("Cache-Control"))
	}
	if !strings.Contains(resp.Body.String(), `"secret_access_key"`) {
		t.Fatalf("body=%s", resp.Body.String())
	}
}

func TestAPIRejectsBadIdentifiers(t *testing.T) {
	called := 0
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) { called++ })
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/accounts/bad%21/zones", nil)
	req.AddCookie(cookie)
	req.Header.Set("Origin", testOrigin)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest || called != 0 {
		t.Fatalf("status=%d upstream=%d body=%s", resp.Code, called, resp.Body.String())
	}
}

func TestAllowedOriginEchoedWithCredentials(t *testing.T) {
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"account1","name":"Main"}],"result_info":{"page":1,"total_pages":1}}`))
	})
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	req.AddCookie(cookie)
	req.Header.Set("Origin", testOrigin)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || resp.Header().Get("Access-Control-Allow-Origin") != testOrigin || resp.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("status=%d headers=%v", resp.Code, resp.Header())
	}
}

func TestOAuthSessionRouteAvailable(t *testing.T) {
	h, upstream, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {})
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.AddCookie(&http.Cookie{Name: "__Host-cf-access", Value: "token"})
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), `"authenticated":true`) {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestInvalidRequestBodyRejected(t *testing.T) {
	called := 0
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) { called++ })
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/accounts/account1/buckets", strings.NewReader(`{"name":"bad/../name","jurisdiction":"default"}`))
	req.AddCookie(cookie)
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest || called != 0 {
		t.Fatalf("status=%d upstream=%d", resp.Code, called)
	}
}

func TestNoWildcardCORS(t *testing.T) {
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": []any{}})
	})
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	req.AddCookie(cookie)
	req.Header.Set("Origin", "null")
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Header().Get("Access-Control-Allow-Origin") == "*" {
		t.Fatal("wildcard CORS returned")
	}
}

func TestRejectedCloudflareTokenClearsCookie(t *testing.T) {
	h, upstream, cookie := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"message":"invalid token"}]}`))
	})
	defer upstream.Close()
	req := httptest.NewRequest(http.MethodGet, "/api/accounts", nil)
	req.AddCookie(cookie)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", resp.Code)
	}
	cleared := false
	for _, c := range resp.Result().Cookies() {
		if c.Name == "__Host-cf-access" && c.MaxAge < 0 && c.Value == "" {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("OAuth cookie was not cleared: %v", resp.Result().Cookies())
	}
}
