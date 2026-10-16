package auth

import (
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

// Config describes the OAuth endpoints and the configured browser origins.
type Config struct {
	ClientID         string
	PublicOrigin     string
	CommanderOrigin  string
	AuthorizationURL string
	TokenURL         string
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
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
}

func NewHandler(cfg Config, client *http.Client, now func() time.Time) (*Handler, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return nil, errors.New("OAuth client ID is required")
	}
	if err := validateOrigin(cfg.PublicOrigin); err != nil {
		return nil, fmt.Errorf("invalid public origin: %w", err)
	}
	if err := validateOrigin(cfg.CommanderOrigin); err != nil {
		return nil, fmt.Errorf("invalid Commander origin: %w", err)
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

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/start", h.start)
	mux.HandleFunc("GET /auth/callback", h.callback)
	mux.HandleFunc("GET /api/session", h.session)
}

func (h *Handler) Token(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(accessCookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	return cookie.Value, true
}

// ClearToken expires the user's OAuth cookie after Cloudflare rejects it.
func (h *Handler) ClearToken(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: accessCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0), MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (h *Handler) start(w http.ResponseWriter, r *http.Request) {
	openerOrigin := r.URL.Query().Get("opener_origin")
	if !h.allowedOpenerOrigin(openerOrigin) {
		http.Error(w, "browser origin is not allowed", http.StatusBadRequest)
		return
	}
	state, err := randomURLToken(32)
	if err != nil {
		http.Error(w, "unable to start authorization", http.StatusInternalServerError)
		return
	}
	verifier, err := randomURLToken(32)
	if err != nil {
		http.Error(w, "unable to start authorization", http.StatusInternalServerError)
		return
	}
	payload, err := json.Marshal(transientState{State: state, Verifier: verifier, OpenerOrigin: openerOrigin})
	if err != nil {
		http.Error(w, "unable to start authorization", http.StatusInternalServerError)
		return
	}
	challengeHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeHash[:])
	cookieValue := base64.RawURLEncoding.EncodeToString(payload)
	http.SetCookie(w, &http.Cookie{Name: stateCookieName, Value: cookieValue, Path: "/", Expires: h.now().Add(stateLifetime), MaxAge: int(stateLifetime.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})

	authorization, _ := url.Parse(h.cfg.AuthorizationURL)
	query := authorization.Query()
	query.Set("response_type", "code")
	query.Set("client_id", h.cfg.ClientID)
	query.Set("redirect_uri", strings.TrimRight(h.cfg.PublicOrigin, "/")+"/auth/callback")
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	// Scopes are configured on the Cloudflare OAuth client. Avoid requesting
	// offline_access; this manager deliberately does not refresh tokens.
	authorization.RawQuery = query.Encode()
	http.Redirect(w, r, authorization.String(), http.StatusFound)
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie(stateCookieName)
	if err != nil {
		http.Error(w, "authorization state is missing", http.StatusBadRequest)
		return
	}
	state, err := decodeTransient(stateCookie.Value)
	if err != nil || state.State == "" || state.Verifier == "" || !h.allowedOpenerOrigin(state.OpenerOrigin) || r.URL.Query().Get("state") == "" || r.URL.Query().Get("state") != state.State {
		http.Error(w, "authorization state did not match", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || r.URL.Query().Get("error") != "" {
		http.Error(w, "Cloudflare authorization was not completed", http.StatusBadRequest)
		return
	}
	access, expires, err := h.exchange(r, code, state.Verifier)
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
	_, _ = io.WriteString(w, `<!doctype html><meta charset="utf-8"><title>Cloudflare connected</title><script>if(window.opener){window.opener.postMessage({type:"cloudflare-oauth-complete"},`+strconvQuote(state.OpenerOrigin)+`)}window.close()</script><p>Cloudflare authorization finished. You can close this window.</p>`)
}

func (h *Handler) allowedOpenerOrigin(origin string) bool {
	return origin == h.cfg.PublicOrigin || origin == h.cfg.CommanderOrigin
}

func (h *Handler) exchange(r *http.Request, code, verifier string) (string, time.Duration, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {h.cfg.ClientID},
		"code":          {code},
		"redirect_uri":  {strings.TrimRight(h.cfg.PublicOrigin, "/") + "/auth/callback"},
		"code_verifier": {verifier},
	}
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

func randomURLToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func decodeTransient(value string) (transientState, error) {
	var state transientState
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(data, &state)
	return state, err
}

func validateOrigin(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("must be an HTTPS origin without path, query, or credentials")
	}
	return nil
}

func validateEndpoint(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return errors.New("must be an absolute HTTP(S) URL")
	}
	return nil
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
