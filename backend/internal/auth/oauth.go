package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	accessCookieName         = "__Host-cf-access"
	insecureAccessCookieName = "cf-access"
	stateLifetime            = 10 * time.Minute
	maxTokenResponse         = 1 << 20
	requiredScopes           = "account-settings.read zone.read workers-r2.read workers-r2.write account-api-tokens.write"
)

type Config struct {
	AuthorizationURL, TokenURL string
	StateStore                 StateStore
	ManagerID                  string
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
type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

func NewHandler(cfg Config, client *http.Client, now func() time.Time) (*Handler, error) {
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
	if input.OpenerOrigin != browserOrigin {
		return "", errors.New("opener origin must match browser origin")
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
	if h.cfg.StateStore == nil || h.cfg.ManagerID == "" {
		return "", errors.New("pending OAuth state storage is unavailable")
	}
	transient := PendingState{Verifier: verifier, OpenerOrigin: input.OpenerOrigin, ClientID: input.ClientID, RedirectURI: redirect, ManagerID: h.cfg.ManagerID, ExpiresAt: h.now().Add(stateLifetime).Unix()}
	if err := h.cfg.StateStore.Put(r.Context(), state, transient); err != nil {
		slog.Warn("OAuth pending state could not be stored", "event", "oauth_state_write_failed", "flow_id", flowIdentifier(state), "reason", "state_store_unavailable", "request_host", r.Host)
		return "", ErrStateStoreUnavailable
	}
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
	slog.Info("OAuth authorization started", "event", "oauth_start", "flow_id", flowIdentifier(state), "request_host", r.Host, "browser_origin", browserOrigin)
	return authorization.String(), nil
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	stateValues := query["state"]
	stateToken := ""
	if len(stateValues) == 1 {
		stateToken = stateValues[0]
	}
	flowID := flowIdentifier(stateToken)
	if stateToken == "" {
		reason := "state_missing"
		if len(stateValues) > 1 {
			reason = "state_malformed"
		}
		h.logCallbackFailure(r, flowID, reason)
		http.Error(w, "Authorization state is missing or expired. Return to Cloudflare Manager and try signing in again.", http.StatusBadRequest)
		return
	}
	if h.cfg.StateStore == nil {
		h.logCallbackFailure(r, flowID, "state_store_unavailable")
		http.Error(w, "Cloudflare Manager could not verify authorization state. Try again shortly.", http.StatusServiceUnavailable)
		return
	}
	state, err := h.cfg.StateStore.Take(r.Context(), stateToken, h.now())
	if err != nil {
		if errors.Is(err, ErrStateStoreUnavailable) {
			h.logCallbackFailure(r, flowID, "state_store_unavailable")
			http.Error(w, "Cloudflare Manager could not verify authorization state. Try again shortly.", http.StatusServiceUnavailable)
		} else {
			h.logCallbackFailure(r, flowID, "state_invalid_expired_or_used")
			http.Error(w, "Authorization state is missing or expired. Return to Cloudflare Manager and try signing in again.", http.StatusBadRequest)
		}
		return
	}
	if state.ManagerID != h.cfg.ManagerID || state.Verifier == "" || state.ClientID == "" || !validOrigin(state.OpenerOrigin) || !validRedirect(state.RedirectURI) || state.ExpiresAt <= h.now().Unix() || state.RedirectURI != callbackRedirectURI(r) {
		h.logCallbackFailure(r, flowID, "state_context_mismatch")
		http.Error(w, "Authorization state did not match this manager. Return to Cloudflare Manager and try again.", http.StatusBadRequest)
		return
	}
	if providerError := query.Get("error"); providerError != "" {
		message, reason := "Cloudflare authorization was not completed.", "provider_error"
		if providerError == "invalid_scope" {
			message, reason = "Cloudflare rejected a requested permission. Allow these scopes on your OAuth client: "+requiredScopes+".", "invalid_scope"
		}
		h.logCallbackFailure(r, flowID, reason)
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	codeValues := query["code"]
	if len(codeValues) != 1 || codeValues[0] == "" {
		h.logCallbackFailure(r, flowID, "authorization_code_missing")
		http.Error(w, "Cloudflare authorization was not completed", http.StatusBadRequest)
		return
	}
	code := codeValues[0]
	access, expires, err := h.exchange(r, code, state)
	if err != nil {
		h.logCallbackFailure(r, flowID, "token_exchange_failed")
		http.Error(w, "Cloudflare token exchange failed", http.StatusBadGateway)
		return
	}
	now := h.now()
	secure := strings.HasPrefix(state.RedirectURI, "https://")
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
	slog.Info("OAuth callback completed", "event", "oauth_callback", "flow_id", flowID, "reason", "success", "request_host", r.Host)
}

func (h *Handler) logCallbackFailure(r *http.Request, flowID, reason string) {
	slog.Warn("OAuth callback rejected or failed", "event", "oauth_callback", "flow_id", flowID, "reason", reason, "request_host", r.Host)
}

func callbackRedirectURI(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/auth/callback"
}

func flowIdentifier(rawState string) string {
	if rawState == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(rawState))
	return hex.EncodeToString(digest[:6])
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

func (h *Handler) exchange(r *http.Request, code string, state PendingState) (string, time.Duration, error) {
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
