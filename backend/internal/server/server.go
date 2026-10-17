package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
	managerjwt "github.com/ezenki-hq/cloudflare-manager/backend/internal/jwt"
	managerpkg "github.com/ezenki-hq/cloudflare-manager/backend/internal/manager"
)

const maxJSONBody = 32 << 10

type Config struct {
	ManagerID string
	JWTSecret []byte
	StaticDir string
}
type Server struct {
	cfg       Config
	oauth     *auth.Handler
	cf        *cloudflare.Client
	commander *commander.Client
	manager   *managerpkg.Service
}

func NewHandler(cfg Config, oauth *auth.Handler, cf *cloudflare.Client, commanderClient *commander.Client) http.Handler {
	s := &Server{cfg: cfg, oauth: oauth, cf: cf, commander: commanderClient}
	if commanderClient != nil {
		s.manager = managerpkg.NewService(cfg.ManagerID, commanderClient, cf)
	}
	mux := http.NewServeMux()
	if oauth != nil {
		oauth.Register(mux)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /auth/start", s.signed)
	mux.HandleFunc("POST /api/{operation...}", s.signed)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "API route not found")
	})
	if strings.TrimSpace(cfg.StaticDir) != "" {
		static := staticHandler(cfg.StaticDir)
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			static.ServeHTTP(w, r)
		}))
	}
	return s.corsAndCache(mux)
}

func (s *Server) signed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Signed manager operations require POST")
		return
	}
	origin := r.Header.Get("Origin")
	if !validOrigin(origin) {
		writeError(w, http.StatusForbidden, "origin_rejected", "A valid browser origin is required")
		return
	}
	mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
	if mediaType != "application/jwt" {
		writeError(w, http.StatusUnsupportedMediaType, "content_type_required", "Request body must be a compact JWT")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_token", "Invalid request token")
		return
	}
	claims, err := managerjwt.Verify(string(raw), s.cfg.JWTSecret, s.cfg.ManagerID, r.URL.Path, origin, time.Now())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_token", "Invalid or expired request token")
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	if err := s.dispatch(w, r, claims.Data); err != nil {
		var response *routeError
		if errors.As(err, &response) {
			writeError(w, response.status, response.code, response.message)
		} else {
			writeError(w, http.StatusBadGateway, "request_failed", err.Error())
		}
	}
}

type routeError struct {
	status        int
	code, message string
}

func (e *routeError) Error() string               { return e.message }
func fail(status int, code, message string) error { return &routeError{status, code, message} }
func decodeData(raw json.RawMessage, dst any) error {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}
func decodeRequest(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
func (s *Server) cloudflareToken(w http.ResponseWriter, r *http.Request) (string, error) {
	if s.oauth == nil {
		return "", fail(http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
	}
	token, ok := s.oauth.Token(r)
	if !ok {
		return "", fail(http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
	}
	return token, nil
}
func (s *Server) upstreamError(w http.ResponseWriter, err error) error {
	status := http.StatusBadGateway
	var apiErr *cloudflare.APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == http.StatusUnauthorized && s.oauth != nil {
			s.oauth.ClearToken(w)
		}
		if apiErr.Status >= 400 && apiErr.Status < 500 {
			status = apiErr.Status
		}
		return fail(status, "cloudflare_error", fmt.Sprintf("Cloudflare API: %s", apiErr.Message))
	}
	return fail(status, "cloudflare_error", err.Error())
}

func (s *Server) corsAndCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/auth/start") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if !validOrigin(origin) {
				writeError(w, http.StatusForbidden, "origin_rejected", "A valid browser origin is required")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	return decodeRequest(w, r, dst)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func validID(v string) bool {
	if len(v) == 0 || len(v) > 64 {
		return false
	}
	for _, r := range v {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func validBucketName(v string) bool {
	return len(v) >= 3 && len(v) <= 63 && strings.Trim(v, "abcdefghijklmnopqrstuvwxyz0123456789-") == "" && v[0] != '-' && v[len(v)-1] != '-'
}
func validJurisdiction(v string) bool {
	switch v {
	case "default", "eu", "us", "fedramp", "fedramp-high":
		return true
	}
	return false
}
func validDomain(v string) bool {
	u, e := url.Parse("https://" + v)
	return e == nil && u.Host == v && u.User == nil && !strings.Contains(v, "..") && len(v) <= 253
}
func validOrigin(v string) bool {
	u, err := url.Parse(v)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}
func staticHandler(directory string) http.Handler {
	root, e := filepath.Abs(directory)
	if e != nil {
		return http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean("/" + r.URL.Path)
		filename := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
		rel, e := filepath.Rel(root, filename)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}
		info, e := os.Stat(filename)
		if e != nil || info.IsDir() {
			if strings.Contains(filepath.Base(clean), ".") {
				http.NotFound(w, r)
				return
			}
			filename = filepath.Join(root, "index.html")
		}
		http.ServeFile(w, r, filename)
	})
}
