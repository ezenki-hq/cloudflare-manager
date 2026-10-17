package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
)

const (
	testOrigin  = "https://frontend.example.test"
	testManager = "manager-1"
)

var testKey = []byte("01234567890123456789012345678901")

func signedRequest(t *testing.T, path, origin string, data any) *http.Request {
	t.Helper()
	dataBytes, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"aud": testManager, "path": path, "origin": origin, "iat": now, "exp": now + 60, "data": json.RawMessage(dataBytes)})
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, testKey)
	_, _ = mac.Write([]byte(unsigned))
	token := unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(token))
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/jwt")
	req.AddCookie(&http.Cookie{Name: "__Host-cf-access", Value: "test-token"})
	return req
}

func TestSignedRouteRequiresCorrectJWTAndReturnsNoStore(t *testing.T) {
	called := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"account1","name":"Main"}],"result_info":{"page":1,"total_pages":1}}`))
	}))
	defer upstream.Close()
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token", StateKey: testKey}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, cloudflare.NewClient(upstream.URL, upstream.Client()), nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, signedRequest(t, "/api/accounts/list", testOrigin, map[string]any{}))
	if resp.Code != http.StatusOK || called != 1 || resp.Header().Get("Cache-Control") != "no-store" || resp.Header().Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatalf("status=%d called=%d headers=%v body=%s", resp.Code, called, resp.Header(), resp.Body.String())
	}
}

func TestSignedRouteRejectsLegacyAndMismatchedJWT(t *testing.T) {
	called := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++ }))
	defer upstream.Close()
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, nil, cloudflare.NewClient(upstream.URL, upstream.Client()), nil)
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/accounts", nil),
		signedRequest(t, "/api/accounts/list", "https://other.example", map[string]any{}),
		signedRequest(t, "/api/session", testOrigin, map[string]any{}),
	} {
		resp := httptest.NewRecorder()
		h.ServeHTTP(resp, req)
		if resp.Code < 400 {
			t.Errorf("%s %s status=%d", req.Method, req.URL.Path, resp.Code)
		}
	}
	if called != 0 {
		t.Fatalf("upstream called %d times", called)
	}
}

func TestSignedRouteValidatesTypedDataBeforeCloudflare(t *testing.T) {
	called := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++ }))
	defer upstream.Close()
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, nil, cloudflare.NewClient(upstream.URL, upstream.Client()), nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, signedRequest(t, "/api/zones/list", testOrigin, map[string]any{"account_id": "bad!"}))
	if resp.Code != http.StatusBadRequest || called != 0 {
		t.Fatalf("status=%d called=%d body=%s", resp.Code, called, resp.Body.String())
	}
}

func TestSafePreflightAndStaticHealthExceptions(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("manager interface"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey, StaticDir: staticDir}, nil, cloudflare.NewClient("https://api.cloudflare.com", nil), nil)
	preflight := httptest.NewRequest(http.MethodOptions, "/api/accounts/list", nil)
	preflight.Header.Set("Origin", testOrigin)
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, preflight)
	if resp.Code != http.StatusNoContent || resp.Header().Get("Access-Control-Allow-Origin") != testOrigin {
		t.Fatalf("preflight status=%d headers=%v", resp.Code, resp.Header())
	}
	for _, path := range []string{"/healthz", "/"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("GET %s status=%d", path, rr.Code)
		}
	}
}

func TestOAuthStartIsSignedPostAndRequiresCookieForSession(t *testing.T) {
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, nil, cloudflare.NewClient("https://api.cloudflare.com", nil), nil)
	for _, path := range []string{"/auth/start", "/api/session"} {
		resp := httptest.NewRecorder()
		h.ServeHTTP(resp, signedRequest(t, path, testOrigin, map[string]any{"client_id": "client", "opener_origin": testOrigin, "api_origin": "https://manager.example.test"}))
		if resp.Code == http.StatusNotFound {
			t.Errorf("missing route %s", path)
		}
	}
}
