package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type memoryStateStore struct {
	states   map[string]PendingState
	putErr   error
	takeErr  error
	pruneErr error
	takes    int
}

func (s *memoryStateStore) Put(_ context.Context, rawState string, value PendingState) error {
	if s.putErr != nil {
		return s.putErr
	}
	if s.states == nil {
		s.states = make(map[string]PendingState)
	}
	s.states[stateRecordID(rawState)] = value
	return nil
}

func (s *memoryStateStore) Take(_ context.Context, rawState string, now time.Time) (PendingState, error) {
	s.takes++
	if s.takeErr != nil {
		return PendingState{}, s.takeErr
	}
	id := stateRecordID(rawState)
	value, exists := s.states[id]
	if !exists || value.ExpiresAt <= now.Unix() {
		return PendingState{}, errors.New("pending state missing or expired")
	}
	delete(s.states, id)
	return value, nil
}

func (s *memoryStateStore) Prune(_ context.Context, now time.Time) (int, error) {
	if s.pruneErr != nil {
		return 0, s.pruneErr
	}
	removed := 0
	for id, value := range s.states {
		if value.ExpiresAt <= now.Unix() {
			delete(s.states, id)
			removed++
		}
	}
	return removed, nil
}

func oauthTestHandler(t *testing.T, tokenServer *httptest.Server, now func() time.Time) *Handler {
	t.Helper()
	h, e := NewHandler(Config{AuthorizationURL: "https://cloudflare.example/oauth/authorize", TokenURL: tokenServer.URL, StateStore: &memoryStateStore{}, ManagerID: "manager-a"}, tokenServer.Client(), now)
	if e != nil {
		t.Fatal(e)
	}
	return h
}

func TestTokenReturnsUnauthenticatedWhenCookieIsMissingOrEmpty(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)

	for _, tc := range []struct {
		name   string
		cookie *http.Cookie
	}{
		{name: "missing"},
		{name: "empty", cookie: &http.Cookie{Name: accessCookieName, Value: ""}},
		{name: "insecure cookie on HTTPS origin", cookie: &http.Cookie{Name: insecureAccessCookieName, Value: "http-token"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "https://manager.test/api/session", nil)
			r.Header.Set("Origin", "https://manager.test")
			if tc.cookie != nil {
				r.AddCookie(tc.cookie)
			}
			if token, ok := h.Token(r); ok || token != "" {
				t.Fatalf("Token() = (%q, %t), want empty unauthenticated result", token, ok)
			}
		})
	}
}

func TestOAuthStartAndCallbackUseSignedStateAndSavedClientID(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	var gotForm url.Values
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.Form
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "opaque-access-token", "expires_in": 900})
	}))
	defer tokenServer.Close()
	h := oauthTestHandler(t, tokenServer, func() time.Time { return now })
	startReq := httptest.NewRequest(http.MethodPost, "https://manager.example.test/auth/start", nil)
	startReq.Header.Set("Origin", "https://frontend.example.test")
	recorder := httptest.NewRecorder()
	authURL, err := h.Start(recorder, startReq, StartInput{ClientID: "client-before-edit", OpenerOrigin: "https://frontend.example.test", APIOrigin: "https://manager.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(authURL)
	if parsed.Query().Get("client_id") != "client-before-edit" || parsed.Query().Get("redirect_uri") != "https://manager.example.test/auth/callback" || parsed.Query().Get("code_challenge_method") != "S256" || parsed.Query().Get("scope") != "account-settings.read zone.read workers-r2.read workers-r2.write account-api-tokens.write" {
		t.Fatalf("unexpected URL %s", authURL)
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatalf("OAuth start must not set a state cookie: %#v", recorder.Result().Cookies())
	}
	state := h.cfg.StateStore.(*memoryStateStore).states[stateRecordID(parsed.Query().Get("state"))]
	if state.Verifier == "" || state.ExpiresAt != now.Add(stateLifetime).Unix() || state.ManagerID != "manager-a" {
		t.Fatalf("saved pending state = %#v", state)
	}
	digest := sha256.Sum256([]byte(state.Verifier))
	if parsed.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(digest[:]) {
		t.Fatal("PKCE challenge mismatch")
	}
	callback := httptest.NewRequest(http.MethodGet, "https://manager.example.test/auth/callback?code=abc&state="+url.QueryEscape(parsed.Query().Get("state")), nil)
	out := httptest.NewRecorder()
	h.callback(out, callback)
	if out.Code != http.StatusOK || gotForm.Get("client_id") != "client-before-edit" || gotForm.Get("redirect_uri") != "https://manager.example.test/auth/callback" || !strings.Contains(out.Body.String(), `"https://frontend.example.test"`) {
		t.Fatalf("status=%d form=%v body=%s", out.Code, gotForm, out.Body.String())
	}
	var access bool
	for _, c := range out.Result().Cookies() {
		if c.Name == accessCookieName && c.HttpOnly && c.Secure && c.Value == "opaque-access-token" {
			access = true
		}
	}
	if !access {
		t.Fatal("secure HttpOnly access cookie missing")
	}
	if _, exists := h.cfg.StateStore.(*memoryStateStore).states[stateRecordID(parsed.Query().Get("state"))]; exists {
		t.Fatal("callback did not consume state")
	}
}

func TestOAuthStartChecksAPIHostAndOrigin(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	for _, in := range []StartInput{{ClientID: "", OpenerOrigin: "https://front.test", APIOrigin: "https://manager.test"}, {ClientID: "id", OpenerOrigin: "null", APIOrigin: "https://manager.test"}, {ClientID: "id", OpenerOrigin: "https://front.test", APIOrigin: "https://attacker.test"}} {
		r := httptest.NewRequest(http.MethodPost, "https://manager.test/auth/start", nil)
		r.Header.Set("Origin", in.OpenerOrigin)
		w := httptest.NewRecorder()
		if _, e := h.Start(w, r, in); e == nil || len(w.Result().Cookies()) != 0 {
			t.Errorf("accepted %#v: err=%v cookies=%v", in, e, w.Result().Cookies())
		}
	}
}

func TestOAuthStartRejectsOpenerOriginMismatch(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	r := httptest.NewRequest(http.MethodPost, "https://manager.test/auth/start", nil)
	r.Header.Set("Origin", "https://frontend.test")
	w := httptest.NewRecorder()
	if _, err := h.Start(w, r, StartInput{ClientID: "id", OpenerOrigin: "https://attacker.test", APIOrigin: "https://manager.test"}); err == nil {
		t.Fatal("OAuth start accepted a different popup opener origin")
	}
	if len(h.cfg.StateStore.(*memoryStateStore).states) != 0 || len(w.Result().Cookies()) != 0 {
		t.Fatal("rejected OAuth start persisted state or set cookies")
	}
}

func TestOAuthStartDoesNotReturnURLWhenStateWriteFails(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	h.cfg.StateStore.(*memoryStateStore).putErr = errors.New("Commander unavailable")
	r := httptest.NewRequest(http.MethodPost, "https://manager.test/auth/start", nil)
	r.Header.Set("Origin", "https://manager.test")
	w := httptest.NewRecorder()
	if authorizationURL, err := h.Start(w, r, StartInput{ClientID: "id", OpenerOrigin: "https://manager.test", APIOrigin: "https://manager.test"}); err == nil || authorizationURL != "" {
		t.Fatalf("Start() = %q, %v; want no URL and database error", authorizationURL, err)
	}
}

func TestOAuthStartAcceptsHTTPOriginsAndBuildsHTTPRedirect(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "local-access-token", "expires_in": 900})
	}))
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	r := httptest.NewRequest(http.MethodPost, "http://manager.test/auth/start", nil)
	r.Host = "cloudflare-manager-1:8080"
	r.Header.Set("Origin", "http://manager.test")
	w := httptest.NewRecorder()
	if _, err := h.Start(w, r, StartInput{ClientID: "id", OpenerOrigin: "http://manager.test", APIOrigin: "http://manager.test"}); err != nil {
		t.Fatalf("HTTP OAuth start rejected: %v", err)
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatalf("HTTP OAuth start set a state cookie: %#v", w.Result().Cookies())
	}
	stateValue := "state-in-database"
	state := PendingState{Verifier: "verifier", ClientID: "id", OpenerOrigin: "http://manager.test", RedirectURI: "http://manager.test/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	if err := h.cfg.StateStore.Put(context.Background(), stateValue, state); err != nil {
		t.Fatal(err)
	}
	callback := httptest.NewRequest(http.MethodGet, "http://manager.test/auth/callback?code=abc&state="+url.QueryEscape(stateValue), nil)
	out := httptest.NewRecorder()
	h.callback(out, callback)
	if out.Code != http.StatusOK {
		t.Fatalf("HTTP callback status=%d body=%s", out.Code, out.Body.String())
	}
	var accessCookie *http.Cookie
	for _, cookie := range out.Result().Cookies() {
		if cookie.Name == insecureAccessCookieName {
			accessCookie = cookie
		}
	}
	if accessCookie == nil || accessCookie.Secure || !accessCookie.HttpOnly {
		t.Fatal("HTTP flow must set an HttpOnly access cookie without Secure")
	}
	request := httptest.NewRequest(http.MethodPost, "http://manager.test/api/session", nil)
	request.Header.Set("Origin", "http://manager.test")
	request.AddCookie(accessCookie)
	if token, ok := h.Token(request); !ok || token != "local-access-token" {
		t.Fatalf("HTTP Token() = (%q, %t), want local access token", token, ok)
	}
}

func TestOAuthProviderErrorsAreExplainedWithoutStateCookie(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	for _, tc := range []struct{ code, want string }{
		{"invalid_scope", "account-settings.read zone.read workers-r2.read workers-r2.write account-api-tokens.write"},
		{"access_denied", "Cloudflare authorization was not completed."},
	} {
		t.Run(tc.code, func(t *testing.T) {
			state := PendingState{Verifier: "v", ClientID: "id", OpenerOrigin: "https://front.test", RedirectURI: "https://manager.test/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
			if err := h.cfg.StateStore.Put(context.Background(), "state", state); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodGet, "https://manager.test/auth/callback?error="+tc.code+"&error_description=do-not-reflect&state=state", nil)
			w := httptest.NewRecorder()
			h.callback(w, r)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tc.want) || strings.Contains(w.Body.String(), "do-not-reflect") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestOAuthStartRejectsAPIOriginDifferentFromBrowserOrigin(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	r := httptest.NewRequest(http.MethodPost, "https://internal-service:8080/auth/start", nil)
	r.Header.Set("Origin", "https://frontend.example.test")
	w := httptest.NewRecorder()
	_, err := h.Start(w, r, StartInput{ClientID: "id", OpenerOrigin: "https://frontend.example.test", APIOrigin: "https://attacker.example.test"})
	if err == nil || len(w.Result().Cookies()) != 0 {
		t.Fatalf("mismatched browser/API origins accepted: err=%v cookies=%v", err, w.Result().Cookies())
	}
}

func TestOAuthRejectsForgedExpiredAndMismatchedState(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("forged state reached token endpoint") }))
	defer ts.Close()
	now := time.Now()
	h := oauthTestHandler(t, ts, func() time.Time { return now })
	for _, test := range []struct {
		name       string
		state      PendingState
		requestURL string
	}{
		{name: "missing", requestURL: "https://manager.test/auth/callback?code=bad&state=missing"},
		{name: "expired", state: PendingState{Verifier: "v", ClientID: "id", RedirectURI: "https://manager.test/auth/callback", OpenerOrigin: "https://front.test", ManagerID: "manager-a", ExpiresAt: now.Add(-time.Second).Unix()}, requestURL: "https://manager.test/auth/callback?code=bad&state=expired"},
		{name: "wrong host", state: PendingState{Verifier: "v", ClientID: "id", RedirectURI: "https://manager.test/auth/callback", OpenerOrigin: "https://front.test", ManagerID: "manager-a", ExpiresAt: now.Add(time.Minute).Unix()}, requestURL: "https://attacker.test/auth/callback?code=bad&state=wrong-host"},
	} {
		if test.name != "missing" {
			stateValue := strings.TrimPrefix(test.name, "wrong ")
			if test.name == "wrong host" {
				stateValue = "wrong-host"
			}
			if err := h.cfg.StateStore.Put(context.Background(), stateValue, test.state); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(http.MethodGet, test.requestURL, nil)
		w := httptest.NewRecorder()
		h.callback(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s status=%d body=%s", test.name, w.Code, w.Body.String())
		}
	}
}

func TestOAuthLogsOnlySanitizedCallbackFailure(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	r := httptest.NewRequest(http.MethodGet, "https://manager.test/auth/callback?state=private-state-value&code=private-code-value", nil)
	w := httptest.NewRecorder()
	h.callback(w, r)
	if !strings.Contains(logs.String(), "oauth_callback") || strings.Contains(logs.String(), "private-state-value") || strings.Contains(logs.String(), "private-code-value") || strings.Contains(logs.String(), r.URL.String()) {
		t.Fatalf("unsafe or missing callback diagnostics: %s", logs.String())
	}
}

func TestOAuthCallbackRejectsDuplicateStateAndStoreOutage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("invalid callback reached token endpoint")
	}))
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	for _, tc := range []struct {
		name       string
		requestURL string
		takeErr    error
		wantStatus int
	}{
		{name: "duplicate state", requestURL: "https://manager.test/auth/callback?state=a&state=b&code=secret", wantStatus: http.StatusBadRequest},
		{name: "database outage", requestURL: "https://manager.test/auth/callback?state=a&code=secret", takeErr: ErrStateStoreUnavailable, wantStatus: http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := h.cfg.StateStore.(*memoryStateStore)
			previousTakes := store.takes
			store.takeErr = tc.takeErr
			w := httptest.NewRecorder()
			h.callback(w, httptest.NewRequest(http.MethodGet, tc.requestURL, nil))
			store.takeErr = nil
			if w.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s; want %d", w.Code, w.Body.String(), tc.wantStatus)
			}
			if tc.name == "duplicate state" && store.takes != previousTakes {
				t.Fatal("duplicate state parameters reached the state store")
			}
		})
	}
}
