package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
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

type routeStateStore struct {
	putErr  error
	takeErr error
	pending auth.PendingState
}

func (s *routeStateStore) Put(context.Context, string, auth.PendingState) error { return s.putErr }
func (s *routeStateStore) Take(context.Context, string, time.Time) (auth.PendingState, error) {
	if s.takeErr != nil {
		return auth.PendingState{}, s.takeErr
	}
	return s.pending, nil
}
func (*routeStateStore) Prune(context.Context, time.Time) (int, error) { return 0, nil }

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
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, nil, nil)
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

func TestSignedRouteAcceptsHTTPOrigin(t *testing.T) {
	c := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c++
		_, _ = w.Write([]byte(`{"success":true,"result":[],"result_info":{"page":1,"total_pages":1}}`))
	}))
	defer upstream.Close()
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, cloudflare.NewClient(upstream.URL, upstream.Client()), nil)
	origin := "http://localhost:4173"
	resp := httptest.NewRecorder()
	req := signedRequest(t, "/api/accounts/list", origin, map[string]any{})
	req.Header.Set("Cookie", "cf-access=test-token")
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || c != 1 || resp.Header().Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("status=%d called=%d headers=%v body=%s", resp.Code, c, resp.Header(), resp.Body.String())
	}
}

func TestSignedSessionWithoutAccessCookieReturnsUnauthorized(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, cloudflare.NewClient(ts.URL, ts.Client()), nil)
	req := signedRequest(t, "/api/session", testOrigin, map[string]any{})
	req.Header.Del("Cookie")
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized || !strings.Contains(resp.Body.String(), `"code":"unauthorized"`) {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestSignedOAuthStartAcceptsPublicOriginBehindInternalHost(t *testing.T) {
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token", StateStore: &routeStateStore{}, ManagerID: testManager}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, nil, nil)
	req := signedRequest(t, "/auth/start", testOrigin, map[string]any{
		"client_id":     "oauth-client",
		"opener_origin": testOrigin,
		"api_origin":    testOrigin,
	})
	req.Host = "cloudflare-manager-1:8080"
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), "redirect_uri=https%3A%2F%2Ffrontend.example.test%2Fauth%2Fcallback") {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestSignedOAuthStartReturnsServiceUnavailableWhenStateWriteFails(t *testing.T) {
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token", StateStore: &routeStateStore{putErr: auth.ErrStateStoreUnavailable}, ManagerID: testManager}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, nil, nil)
	req := signedRequest(t, "/auth/start", testOrigin, map[string]any{"client_id": "oauth-client", "opener_origin": testOrigin, "api_origin": testOrigin})
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusServiceUnavailable || strings.Contains(resp.Body.String(), "authorization_url") {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestSignedOAuthStartIdentifiesRejectedStateQuery(t *testing.T) {
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token", StateStore: &routeStateStore{putErr: auth.ErrStateStoreRejected}, ManagerID: testManager}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, nil, nil)
	req := signedRequest(t, "/auth/start", testOrigin, map[string]any{"client_id": "oauth-client", "opener_origin": testOrigin, "api_origin": testOrigin})
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadGateway || !strings.Contains(resp.Body.String(), `"code":"commander_query_failed"`) || strings.Contains(resp.Body.String(), "authorization_url") {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestSignedOAuthStartIdentifiesInvalidCommanderResponse(t *testing.T) {
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token", StateStore: &routeStateStore{putErr: auth.ErrStateStoreInvalidResponse}, ManagerID: testManager}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, nil, nil)
	req := signedRequest(t, "/auth/start", testOrigin, map[string]any{"client_id": "oauth-client", "opener_origin": testOrigin, "api_origin": testOrigin})
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadGateway || !strings.Contains(resp.Body.String(), `"code":"commander_response_invalid"`) {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestSignedRoutesUseCallbackSessionHandleWithoutCookies(t *testing.T) {
	var tokenCalls, accountCalls int
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			tokenCalls++
			if err := r.ParseForm(); err != nil || r.Form.Get("code_verifier") != "saved-pkce-verifier" {
				t.Errorf("token request form = %v, err=%v", r.Form, err)
			}
			writeJSON(w, http.StatusOK, map[string]any{"access_token": "raw-cloudflare-access-token", "expires_in": 900})
			return
		}
		t.Error("unexpected request to token server", r.URL.Path)
	}))
	defer tokenServer.Close()
	state := auth.PendingState{Verifier: "saved-pkce-verifier", OpenerOrigin: testOrigin, ClientID: "client-1", RedirectURI: "https://manager.example.test/auth/callback", ManagerID: testManager, ExpiresAt: time.Now().Add(10 * time.Minute).Unix()}
	oauthHandler, err := auth.NewHandler(auth.Config{AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: tokenServer.URL + "/token", StateStore: &routeStateStore{pending: state}, ManagerID: testManager}, tokenServer.Client(), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	callbackMux := http.NewServeMux()
	oauthHandler.Register(callbackMux)
	callback := httptest.NewRequest(http.MethodGet, "https://manager.example.test/auth/callback?state=oauth-state&code=authorization-code", nil)
	callbackResponse := httptest.NewRecorder()
	callbackMux.ServeHTTP(callbackResponse, callback)
	if callbackResponse.Code != http.StatusOK || tokenCalls != 1 {
		t.Fatalf("callback status=%d token calls=%d body=%s", callbackResponse.Code, tokenCalls, callbackResponse.Body.String())
	}
	match := regexp.MustCompile(`"session_handle":"([A-Za-z0-9_-]+)"`).FindStringSubmatch(callbackResponse.Body.String())
	if len(match) != 2 || strings.Contains(callbackResponse.Body.String(), "raw-cloudflare-access-token") {
		t.Fatalf("callback session handle missing or token exposed: %s", callbackResponse.Body.String())
	}
	handle := match[1]

	cloudflareStatus := http.StatusOK
	cloudflareServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accountCalls++
		if r.Header.Get("Authorization") != "Bearer raw-cloudflare-access-token" {
			t.Errorf("Cloudflare Authorization = %q", r.Header.Get("Authorization"))
		}
		if cloudflareStatus != http.StatusOK {
			writeJSON(w, cloudflareStatus, map[string]any{"success": false, "errors": []any{map[string]any{"code": 10000, "message": "unauthorized"}}})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": []any{map[string]any{"id": "account-1", "name": "Account"}}, "result_info": map[string]any{"page": 1, "total_pages": 1}})
	}))
	defer cloudflareServer.Close()
	server := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, oauthHandler, cloudflare.NewClient(cloudflareServer.URL, cloudflareServer.Client()), nil)
	sessionRequest := signedRequest(t, "/api/session", testOrigin, map[string]any{})
	sessionRequest.Header.Del("Cookie")
	sessionRequest.Header.Set("X-Cloudflare-Session", handle)
	sessionResponse := httptest.NewRecorder()
	server.ServeHTTP(sessionResponse, sessionRequest)
	if sessionResponse.Code != http.StatusOK || !strings.Contains(sessionResponse.Body.String(), `"authenticated":true`) {
		t.Fatalf("session status=%d body=%s", sessionResponse.Code, sessionResponse.Body.String())
	}

	accountsRequest := signedRequest(t, "/api/accounts/list", testOrigin, map[string]any{})
	accountsRequest.Header.Del("Cookie")
	accountsRequest.Header.Set("X-Cloudflare-Session", handle)
	accountsResponse := httptest.NewRecorder()
	server.ServeHTTP(accountsResponse, accountsRequest)
	if accountsResponse.Code != http.StatusOK || accountCalls != 1 {
		t.Fatalf("accounts status=%d calls=%d body=%s", accountsResponse.Code, accountCalls, accountsResponse.Body.String())
	}

	wrongOriginRequest := signedRequest(t, "/api/session", "https://other.example.test", map[string]any{})
	wrongOriginRequest.Header.Del("Cookie")
	wrongOriginRequest.Header.Set("X-Cloudflare-Session", handle)
	wrongOriginResponse := httptest.NewRecorder()
	server.ServeHTTP(wrongOriginResponse, wrongOriginRequest)
	if wrongOriginResponse.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-origin session status=%d body=%s", wrongOriginResponse.Code, wrongOriginResponse.Body.String())
	}

	cloudflareStatus = http.StatusUnauthorized
	rejectedRequest := signedRequest(t, "/api/accounts/list", testOrigin, map[string]any{})
	rejectedRequest.Header.Del("Cookie")
	rejectedRequest.Header.Set(auth.SessionHeader, handle)
	rejectedResponse := httptest.NewRecorder()
	server.ServeHTTP(rejectedResponse, rejectedRequest)
	if rejectedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("rejected token response status=%d body=%s", rejectedResponse.Code, rejectedResponse.Body.String())
	}
	afterRejection := signedRequest(t, "/api/session", testOrigin, map[string]any{})
	afterRejection.Header.Del("Cookie")
	afterRejection.Header.Set(auth.SessionHeader, handle)
	afterRejectionResponse := httptest.NewRecorder()
	server.ServeHTTP(afterRejectionResponse, afterRejection)
	if afterRejectionResponse.Code != http.StatusUnauthorized {
		t.Fatalf("rejected Cloudflare session handle remained valid: status=%d body=%s", afterRejectionResponse.Code, afterRejectionResponse.Body.String())
	}
}

func TestSessionHeaderIsAllowedByCORSPreflight(t *testing.T) {
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, nil, nil, nil)
	request := httptest.NewRequest(http.MethodOptions, "/api/session", nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set("Access-Control-Request-Headers", "content-type, x-cloudflare-session")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !strings.Contains(strings.ToLower(response.Header().Get("Access-Control-Allow-Headers")), "x-cloudflare-session") {
		t.Fatalf("status=%d allow-headers=%q", response.Code, response.Header().Get("Access-Control-Allow-Headers"))
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

func TestSignedRouteRejectsFieldsOutsideRouteContract(t *testing.T) {
	h := NewHandler(Config{ManagerID: testManager, JWTSecret: testKey}, nil, cloudflare.NewClient("https://api.cloudflare.com", nil), nil)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, signedRequest(t, "/api/session", testOrigin, map[string]any{"account_id": "account1"}))
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
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

func TestStaticHandlerServesTeardownRouteFromIndex(t *testing.T) {
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("manager interface"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := staticHandler(staticDir)
	resp := httptest.NewRecorder()
	h.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/teardown?context=commander%2F1", nil))
	if resp.Code != http.StatusOK || resp.Body.String() != "manager interface" {
		t.Fatalf("status=%d body=%q", resp.Code, resp.Body.String())
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
