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

var testStateKey = []byte("state-signing-key-must-be-at-least-32-bytes")

func oauthTestHandler(t *testing.T, tokenServer *httptest.Server, now func() time.Time) *Handler {
	t.Helper()
	h, e := NewHandler(Config{AuthorizationURL: "https://cloudflare.example/oauth/authorize", TokenURL: tokenServer.URL, StateKey: testStateKey}, tokenServer.Client(), now)
	if e != nil {
		t.Fatal(e)
	}
	return h
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
	recorder := httptest.NewRecorder()
	authURL, err := h.Start(recorder, startReq, StartInput{ClientID: "client-before-edit", OpenerOrigin: "https://frontend.example.test", APIOrigin: "https://manager.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(authURL)
	if parsed.Query().Get("client_id") != "client-before-edit" || parsed.Query().Get("redirect_uri") != "https://manager.example.test/auth/callback" || parsed.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("unexpected URL %s", authURL)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatalf("unsafe state cookie: %#v", cookies)
	}
	state, err := h.decodeTransient(cookies[0].Value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(state.Verifier))
	if parsed.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(digest[:]) {
		t.Fatal("PKCE challenge mismatch")
	}
	state.ClientID = "client-after-edit" // callback must use the protected saved client ID instead
	callback := httptest.NewRequest(http.MethodGet, "/auth/callback?code=abc&state="+url.QueryEscape(parsed.Query().Get("state")), nil)
	callback.AddCookie(cookies[0])
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
}

func TestOAuthStartChecksAPIHostAndOrigin(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	for _, in := range []StartInput{{ClientID: "", OpenerOrigin: "https://front.test", APIOrigin: "https://manager.test"}, {ClientID: "id", OpenerOrigin: "null", APIOrigin: "https://manager.test"}, {ClientID: "id", OpenerOrigin: "https://front.test", APIOrigin: "https://attacker.test"}, {ClientID: "id", OpenerOrigin: "https://front.test", APIOrigin: "http://manager.test"}} {
		r := httptest.NewRequest(http.MethodPost, "https://manager.test/auth/start", nil)
		w := httptest.NewRecorder()
		if _, e := h.Start(w, r, in); e == nil || len(w.Result().Cookies()) != 0 {
			t.Errorf("accepted %#v: err=%v cookies=%v", in, e, w.Result().Cookies())
		}
	}
}

func TestOAuthRejectsForgedExpiredAndMismatchedState(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("forged state reached token endpoint") }))
	defer ts.Close()
	now := time.Now()
	h := oauthTestHandler(t, ts, func() time.Time { return now })
	for _, value := range []string{"broken", func() string {
		s := transientState{State: "state", Verifier: "verifier", ClientID: "id", RedirectURI: "https://manager.test/auth/callback", OpenerOrigin: "https://front.test", ExpiresAt: now.Add(-time.Second).Unix()}
		v, _ := h.encodeTransient(s)
		return v
	}()} {
		r := httptest.NewRequest(http.MethodGet, "/auth/callback?code=bad&state=state", nil)
		r.AddCookie(&http.Cookie{Name: stateCookieName, Value: value})
		w := httptest.NewRecorder()
		h.callback(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("value %q status=%d", value, w.Code)
		}
	}
}

func TestOAuthStateSignatureCannotBeModified(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	h := oauthTestHandler(t, ts, time.Now)
	state := transientState{State: "s", Verifier: "v", OpenerOrigin: "https://front.test", ClientID: "id", RedirectURI: "https://manager.test/auth/callback", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	v, _ := h.encodeTransient(state)
	parts := strings.Split(v, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	raw[len(raw)-2] ^= 1
	forged := base64.RawURLEncoding.EncodeToString(raw) + "." + parts[1]
	if _, err := h.decodeTransient(forged); err == nil {
		t.Fatal("modified cookie verified")
	}
}
