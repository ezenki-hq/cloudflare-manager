package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOAuthPKCEAndCookie(t *testing.T) {
	var exchanged bool
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exchanged = true
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("code") != "test-code" || r.Form.Get("client_id") != "client-id" || r.Form.Get("grant_type") != "authorization_code" {
			t.Errorf("unexpected token form: %v", r.Form)
		}
		if r.Form.Get("code_verifier") == "" {
			t.Error("missing PKCE verifier")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "opaque-access-token", "expires_in": 900, "refresh_token": "must-be-discarded"})
	}))
	defer tokenServer.Close()

	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	h, err := NewHandler(Config{
		ClientID: "client-id", PublicOrigin: "https://manager.example.test", CommanderOrigin: "https://commander.example.test",
		AuthorizationURL: "https://cloudflare.example.test/oauth/authorize", TokenURL: tokenServer.URL,
	}, tokenServer.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)

	start := httptest.NewRecorder()
	mux.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/auth/start?opener_origin=https%3A%2F%2Fcommander.example.test", nil))
	if start.Code != http.StatusFound {
		t.Fatalf("start status = %d", start.Code)
	}
	location, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	q := location.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != "client-id" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("unexpected authorization query: %v", q)
	}
	if strings.Contains(q.Get("scope"), "offline_access") {
		t.Fatal("authorization requested offline_access")
	}
	transient := start.Result().Cookies()
	if len(transient) != 1 || !transient[0].HttpOnly || !transient[0].Secure || transient[0].SameSite != http.SameSiteLaxMode || transient[0].Path != "/" || transient[0].Domain != "" {
		t.Fatalf("unsafe transient cookie: %#v", transient)
	}
	state := q.Get("state")
	if state == "" {
		t.Fatal("missing state")
	}

	// The challenge in the authorization request must be derived from the verifier
	// retained in the protected transient cookie.
	transientValue, err := decodeTransient(transient[0].Value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(transientValue.Verifier))
	wantChallenge := base64.RawURLEncoding.EncodeToString(digest[:])
	if q.Get("code_challenge") != wantChallenge || transientValue.State != state {
		t.Fatalf("PKCE mismatch: challenge=%q state=%q", q.Get("code_challenge"), transientValue.State)
	}

	callback := httptest.NewRequest(http.MethodGet, "/auth/callback?code=test-code&state="+url.QueryEscape(state), nil)
	callback.AddCookie(transient[0])
	result := httptest.NewRecorder()
	mux.ServeHTTP(result, callback)
	if result.Code != http.StatusOK || !exchanged {
		t.Fatalf("callback status=%d exchanged=%v body=%s", result.Code, exchanged, result.Body.String())
	}
	if !strings.Contains(result.Body.String(), "https://commander.example.test") || strings.Contains(result.Body.String(), "opaque-access-token") {
		t.Fatal("callback did not notify only the configured origin")
	}
	cookies := result.Result().Cookies()
	var access, cleared *http.Cookie
	for _, cookie := range cookies {
		switch cookie.Name {
		case accessCookieName:
			access = cookie
		case stateCookieName:
			cleared = cookie
		}
	}
	if access == nil || access.Value != "opaque-access-token" || !access.Secure || !access.HttpOnly || access.SameSite != http.SameSiteLaxMode || access.Path != "/" || access.Domain != "" {
		t.Fatalf("unsafe or missing access cookie: %#v", access)
	}
	wantExpiry := now.Add(900 * time.Second)
	if access.MaxAge != 900 || !access.Expires.Equal(wantExpiry) {
		t.Fatalf("cookie expiry mismatch: MaxAge=%d Expires=%s want=%s", access.MaxAge, access.Expires, wantExpiry)
	}
	if cleared == nil || cleared.MaxAge >= 0 || cleared.Value != "" {
		t.Fatalf("transient cookie not cleared: %#v", cleared)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.AddCookie(access)
	if token, ok := h.Token(req); !ok || token != "opaque-access-token" {
		t.Fatalf("Token() = %q, %v", token, ok)
	}
}

func TestOAuthRejectsStateMismatch(t *testing.T) {
	exchanges := 0
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { exchanges++ }))
	defer tokenServer.Close()
	h, err := NewHandler(Config{ClientID: "id", PublicOrigin: "https://manager.example", CommanderOrigin: "https://commander.example", AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: tokenServer.URL}, tokenServer.Client(), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	start := httptest.NewRecorder()
	mux.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/auth/start?opener_origin=https%3A%2F%2Fcommander.example", nil))
	cookie := start.Result().Cookies()[0]
	callback := httptest.NewRequest(http.MethodGet, "/auth/callback?code=bad&state=attacker", nil)
	callback.AddCookie(cookie)
	result := httptest.NewRecorder()
	mux.ServeHTTP(result, callback)
	for _, c := range result.Result().Cookies() {
		if c.Name == accessCookieName && c.Value != "" {
			t.Fatal("state mismatch set access cookie")
		}
	}
	if exchanges != 0 || result.Code != http.StatusBadRequest {
		t.Fatalf("state mismatch: exchanges=%d status=%d", exchanges, result.Code)
	}
}

func TestSessionExpires(t *testing.T) {
	h, err := NewHandler(Config{ClientID: "id", PublicOrigin: "https://manager.example", CommanderOrigin: "https://commander.example", AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, http.DefaultClient, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	r := httptest.NewRecorder()
	mux.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/api/session", nil))
	if r.Code != http.StatusUnauthorized {
		t.Fatalf("session status = %d, want 401", r.Code)
	}
}

func TestOAuthStartValidatesAndStoresOpenerOrigin(t *testing.T) {
	h, err := NewHandler(Config{ClientID: "id", PublicOrigin: "https://manager.example", CommanderOrigin: "https://commander.example", AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, http.DefaultClient, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	for _, origin := range []string{"https://manager.example", "https://commander.example"} {
		t.Run(origin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/start?opener_origin="+url.QueryEscape(origin), nil)
			result := httptest.NewRecorder()
			mux.ServeHTTP(result, req)
			if result.Code != http.StatusFound {
				t.Fatalf("status=%d body=%s", result.Code, result.Body.String())
			}
			cookies := result.Result().Cookies()
			if len(cookies) != 1 {
				t.Fatalf("cookies=%v", cookies)
			}
			state, err := decodeTransient(cookies[0].Value)
			if err != nil || state.OpenerOrigin != origin {
				t.Fatalf("state=%#v err=%v", state, err)
			}
		})
	}
}

func TestOAuthStartRejectsUnlistedOrMissingOpenerOrigin(t *testing.T) {
	h, err := NewHandler(Config{ClientID: "id", PublicOrigin: "https://manager.example", CommanderOrigin: "https://commander.example", AuthorizationURL: "https://cloudflare.example/authorize", TokenURL: "https://cloudflare.example/token"}, http.DefaultClient, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Register(mux)
	for _, target := range []string{"/auth/start", "/auth/start?opener_origin=https%3A%2F%2Fevil.example", "/auth/start?opener_origin=https%3A%2F%2Fcommander.example%2Fpath"} {
		result := httptest.NewRecorder()
		mux.ServeHTTP(result, httptest.NewRequest(http.MethodGet, target, nil))
		if result.Code != http.StatusBadRequest || len(result.Result().Cookies()) != 0 {
			t.Errorf("%s status=%d cookies=%v", target, result.Code, result.Result().Cookies())
		}
	}
}
