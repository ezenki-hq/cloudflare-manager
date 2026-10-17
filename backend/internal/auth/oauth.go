package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	stateCookieName  = "__Host-cf-oauth"
	accessCookieName = "__Host-cf-access"
	stateLifetime    = 10 * time.Minute
	maxTokenResponse = 1 << 20
)

type Config struct {
	AuthorizationURL, TokenURL string
	StateKey                   []byte
}
type StartInput struct {
	ClientID     string `json:"client_id"`
	OpenerOrigin string `json:"opener_origin"`
	APIOrigin    string `json:"api_origin"`
}
type Handler struct {
	cfg    Config
	client *http.Client
	now    func() time.Time
}
type transientState struct {
	State        string `json:"s"`
	Verifier     string `json:"v"`
	OpenerOrigin string `json:"o"`
	ClientID     string `json:"c"`
	RedirectURI  string `json:"r"`
	ExpiresAt    int64  `json:"e"`
}
type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

func NewHandler(cfg Config, client *http.Client, now func() time.Time) (*Handler, error) {
	if len(cfg.StateKey) < 32 {
		return nil, errors.New("OAuth state key must contain at least 32 bytes")
	}
	if err := validateEndpoint(cfg.AuthorizationURL); err != nil {
		return nil, fmt.Errorf("invalid authorization URL: %w", err)
	}
	if err := validateEndpoint(cfg.TokenURL); err != nil {
		return nil, fmt.Errorf("invalid token URL: %w", err)
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	if now == nil {
		now = time.Now
	}
	return &Handler{cfg: cfg, client: client, now: now}, nil
}

// Register installs only the callback exception. OAuth start is a signed POST route.
func (h *Handler) Register(mux *http.ServeMux) { mux.HandleFunc("GET /auth/callback", h.callback) }
func (h *Handler) Token(r *http.Request) (string, bool) {
	c, e := r.Cookie(accessCookieName)
	return c.Value, e == nil && c.Value != ""
}
func (h *Handler) ClearToken(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: accessCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (h *Handler) Start(w http.ResponseWriter, r *http.Request, input StartInput) (string, error) {
	input.ClientID = strings.TrimSpace(input.ClientID)
	if input.ClientID == "" || len(input.ClientID) > 512 {
		return "", errors.New("invalid OAuth client ID")
	}
	if err := validateOrigin(input.OpenerOrigin); err != nil {
		return "", errors.New("invalid opener origin")
	}
	if err := validateOrigin(input.APIOrigin); err != nil {
		return "", errors.New("invalid API origin")
	}
	api, _ := url.Parse(input.APIOrigin)
	if !strings.EqualFold(api.Host, r.Host) {
		return "", errors.New("API origin host does not match request host")
	}
	state, err := randomURLToken(32)
	if err != nil {
		return "", err
	}
	verifier, err := randomURLToken(32)
	if err != nil {
		return "", err
	}
	redirect := strings.TrimRight(input.APIOrigin, "/") + "/auth/callback"
	transient := transientState{State: state, Verifier: verifier, OpenerOrigin: input.OpenerOrigin, ClientID: input.ClientID, RedirectURI: redirect, ExpiresAt: h.now().Add(stateLifetime).Unix()}
	value, err := h.encodeTransient(transient)
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{Name: stateCookieName, Value: value, Path: "/", Expires: h.now().Add(stateLifetime), MaxAge: int(stateLifetime.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	challengeHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])
	authorization, _ := url.Parse(h.cfg.AuthorizationURL)
	q := authorization.Query()
	q.Set("response_type", "code")
	q.Set("client_id", input.ClientID)
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	authorization.RawQuery = q.Encode()
	return authorization.String(), nil
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(stateCookieName)
	if err != nil {
		http.Error(w, "authorization state is missing", http.StatusBadRequest)
		return
	}
	state, err := h.decodeTransient(cookie.Value)
	if err != nil || state.State == "" || state.Verifier == "" || state.ClientID == "" || !validOrigin(state.OpenerOrigin) || !validRedirect(state.RedirectURI) || state.ExpiresAt < h.now().Unix() || r.URL.Query().Get("state") == "" || r.URL.Query().Get("state") != state.State {
		http.Error(w, "authorization state did not match", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || r.URL.Query().Get("error") != "" {
		http.Error(w, "Cloudflare authorization was not completed", http.StatusBadRequest)
		return
	}
	access, expires, err := h.exchange(r, code, state)
	if err != nil {
		http.Error(w, "Cloudflare token exchange failed", http.StatusBadGateway)
		return
	}
	now := h.now()
	http.SetCookie(w, &http.Cookie{Name: stateCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	http.SetCookie(w, &http.Cookie{Name: accessCookieName, Value: access, Path: "/", Expires: now.Add(expires), MaxAge: int(expires.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `<!doctype html><meta charset="utf-8"><title>Cloudflare connected</title><script>if(window.opener){window.opener.postMessage({type:"cloudflare-oauth-complete"},`+quote(state.OpenerOrigin)+`)}window.close()</script><p>Cloudflare authorization finished. You can close this window.</p>`)
}

func (h *Handler) exchange(r *http.Request, code string, state transientState) (string, time.Duration, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {state.ClientID}, "code": {code}, "redirect_uri": {state.RedirectURI}, "code_verifier": {state.Verifier}}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, h.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := h.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", 0, fmt.Errorf("token endpoint returned status %d", resp.StatusCode)
	}
	var token tokenResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxTokenResponse)).Decode(&token); err != nil {
		return "", 0, errors.New("invalid token endpoint response")
	}
	if token.AccessToken == "" || token.ExpiresIn <= 0 || token.ExpiresIn > int64((365*24*time.Hour)/time.Second) {
		return "", 0, errors.New("token endpoint returned invalid access token lifetime")
	}
	return token.AccessToken, time.Duration(token.ExpiresIn) * time.Second, nil
}
func (h *Handler) encodeTransient(value transientState) (string, error) {
	b, e := json.Marshal(value)
	if e != nil {
		return "", e
	}
	body := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, h.cfg.StateKey)
	_, _ = mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func (h *Handler) decodeTransient(value string) (transientState, error) {
	var s transientState
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return s, errors.New("invalid state cookie")
	}
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return s, e
	}
	mac := hmac.New(sha256.New, h.cfg.StateKey)
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return s, errors.New("invalid state cookie")
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return s, e
	}
	e = json.Unmarshal(raw, &s)
	return s, e
}
func (h *Handler) session(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.Token(r); !ok {
		http.Error(w, `{"authenticated":false}`, http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, `{"authenticated":true}`)
}
func randomURLToken(n int) (string, error) {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func validateOrigin(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("must be HTTPS origin")
	}
	return nil
}
func validOrigin(raw string) bool { return validateOrigin(raw) == nil }
func validRedirect(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host != "" && u.Path == "/auth/callback" && u.RawQuery == "" && u.Fragment == "" && u.User == nil
}
func validateEndpoint(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return errors.New("must be an absolute HTTP(S) URL")
	}
	return nil
}
func quote(s string) string { b, _ := json.Marshal(s); return string(b) }
