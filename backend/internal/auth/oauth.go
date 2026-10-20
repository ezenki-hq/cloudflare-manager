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
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	stateCookieName          = "__Host-cf-oauth"
	accessCookieName         = "__Host-cf-access"
	insecureStateCookieName  = "cf-oauth"
	insecureAccessCookieName = "cf-access"
	stateLifetime            = 10 * time.Minute
	maxTokenResponse         = 1 << 20
	requiredScopes           = "account-settings.read zone.read workers-r2.read workers-r2.write account-api-tokens.write"
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
	secure := requestUsesHTTPS(r)
	name := insecureAccessCookieName
	if secure {
		name = accessCookieName
	}
	if c, err := r.Cookie(name); err == nil && c != nil && c.Value != "" {
		return c.Value, true
	}
	return "", false
}
func (h *Handler) ClearToken(w http.ResponseWriter) {
	clearCookie(w, accessCookieName, true)
	clearCookie(w, insecureAccessCookieName, false)
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
	browserOrigin := r.Header.Get("Origin")
	if err := validateOrigin(browserOrigin); err != nil {
		return "", errors.New("invalid browser origin")
	}
	api, _ := url.Parse(input.APIOrigin)
	if input.APIOrigin != browserOrigin && !strings.EqualFold(api.Host, r.Host) {
		slog.Warn("OAuth start rejected because API origin matches neither browser origin nor request host", "api_origin", input.APIOrigin, "browser_origin", browserOrigin, "request_host", r.Host, "forwarded_host", r.Header.Get("X-Forwarded-Host"))
		return "", errors.New("API origin does not match browser origin or request host")
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
	secure := strings.HasPrefix(redirect, "https://")
	name := insecureStateCookieName
	if secure {
		name = stateCookieName
	}
	setCookie(w, name, value, h.now().Add(stateLifetime), int(stateLifetime.Seconds()), secure)
	challengeHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])
	authorization, _ := url.Parse(h.cfg.AuthorizationURL)
	q := authorization.Query()
	q.Set("response_type", "code")
	q.Set("client_id", input.ClientID)
	q.Set("redirect_uri", redirect)
	q.Set("scope", requiredScopes)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	authorization.RawQuery = q.Encode()
	return authorization.String(), nil
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		message := "Cloudflare authorization was not completed."
		if providerError == "invalid_scope" {
			message = "Cloudflare rejected a requested permission. Allow these scopes on your OAuth client: " + requiredScopes + "."
		}
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	state, cookieName, err := h.readStateCookie(r)
	if err != nil {
		http.Error(w, "authorization state is missing", http.StatusBadRequest)
		return
	}
	if state.State == "" || state.Verifier == "" || state.ClientID == "" || !validOrigin(state.OpenerOrigin) || !validRedirect(state.RedirectURI) || state.ExpiresAt < h.now().Unix() || r.URL.Query().Get("state") == "" || r.URL.Query().Get("state") != state.State {
		http.Error(w, "authorization state did not match", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "Cloudflare authorization was not completed", http.StatusBadRequest)
		return
	}
	access, expires, err := h.exchange(r, code, state)
	if err != nil {
		http.Error(w, "Cloudflare token exchange failed", http.StatusBadGateway)
		return
	}
	now := h.now()
	secure := strings.HasPrefix(state.RedirectURI, "https://")
	clearCookie(w, cookieName, secure)
	accessName := insecureAccessCookieName
	if secure {
		accessName = accessCookieName
	}
	setCookie(w, accessName, access, now.Add(expires), int(expires.Seconds()), secure)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `<!doctype html><meta charset="utf-8"><title>Cloudflare connected</title><script>if(window.opener){window.opener.postMessage({type:"cloudflare-oauth-complete"},`+quote(state.OpenerOrigin)+`)}window.close()</script><p>Cloudflare authorization finished. You can close this window.</p>`)
}

func (h *Handler) readStateCookie(r *http.Request) (transientState, string, error) {
	for _, name := range []string{stateCookieName, insecureStateCookieName} {
		cookie, err := r.Cookie(name)
		if err != nil || cookie == nil || cookie.Value == "" {
			continue
		}
		state, err := h.decodeTransient(cookie.Value)
		if err != nil || !validRedirect(state.RedirectURI) {
			continue
		}
		secure := strings.HasPrefix(state.RedirectURI, "https://")
		if name == stateCookieName && secure || name == insecureStateCookieName && !secure {
			return state, name, nil
		}
	}
	return transientState{}, "", errors.New("authorization state cookie is missing or invalid")
}

func requestUsesHTTPS(r *http.Request) bool {
	if forwardedProto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); forwardedProto != "" {
		return strings.EqualFold(forwardedProto, "https")
	}
	if r.TLS != nil {
		return true
	}
	if origin := r.Header.Get("Origin"); validOrigin(origin) {
		u, _ := url.Parse(origin)
		return u.Scheme == "https"
	}
	return true
}

func setCookie(w http.ResponseWriter, name, value string, expires time.Time, maxAge int, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Expires: expires, MaxAge: maxAge, Secure: secure, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func clearCookie(w http.ResponseWriter, name string, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, Secure: secure, HttpOnly: true, SameSite: http.SameSiteLaxMode})
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
	if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("must be HTTP(S) origin")
	}
	return nil
}
func validOrigin(raw string) bool { return validateOrigin(raw) == nil }
func validRedirect(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.Path == "/auth/callback" && u.RawQuery == "" && u.Fragment == "" && u.User == nil
}
func validateEndpoint(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return errors.New("must be an absolute HTTP(S) URL")
	}
	return nil
}
func quote(s string) string { b, _ := json.Marshal(s); return string(b) }
