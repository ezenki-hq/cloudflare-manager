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

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
)

const maxJSONBody = 32 << 10

type Config struct {
	FrontendOrigin string
	StaticDir      string
}

type Server struct {
	cfg   Config
	oauth *auth.Handler
	cf    *cloudflare.Client
}

func NewHandler(cfg Config, oauth *auth.Handler, cf *cloudflare.Client) http.Handler {
	s := &Server{cfg: cfg, oauth: oauth, cf: cf}
	mux := http.NewServeMux()
	if oauth != nil {
		oauth.Register(mux)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/accounts", s.accounts)
	mux.HandleFunc("GET /api/accounts/{account}/zones", s.zones)
	mux.HandleFunc("GET /api/accounts/{account}/buckets", s.buckets)
	mux.HandleFunc("POST /api/accounts/{account}/buckets", s.createBucket)
	mux.HandleFunc("GET /api/accounts/{account}/buckets/{bucket}", s.getBucket)
	mux.HandleFunc("DELETE /api/accounts/{account}/buckets/{bucket}", s.deleteBucket)
	mux.HandleFunc("GET /api/accounts/{account}/buckets/{bucket}/domains", s.domains)
	mux.HandleFunc("POST /api/accounts/{account}/buckets/{bucket}/domains", s.attachDomain)
	mux.HandleFunc("DELETE /api/accounts/{account}/buckets/{bucket}/domains/{domain}", s.detachDomain)
	mux.HandleFunc("POST /api/accounts/{account}/buckets/{bucket}/credentials", s.createCredential)
	mux.HandleFunc("POST /api/accounts/{account}/credentials/revoke", s.revokeCredential)
	mux.HandleFunc("GET /api/accounts/{account}/credentials/find", s.findCredential)
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

func (s *Server) bearer(w http.ResponseWriter, r *http.Request) (string, bool) {
	if s.oauth == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
		return "", false
	}
	token, ok := s.oauth.Token(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
		return "", false
	}
	return token, true
}

func (s *Server) accounts(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	result, err := s.cf.ListAccounts(r.Context(), token)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) zones(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account := r.PathValue("account")
	if !validID(account) {
		writeError(w, 400, "invalid_account", "Invalid account ID")
		return
	}
	result, err := s.cf.ListZones(r.Context(), token, account)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) buckets(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account := r.PathValue("account")
	jurisdiction := jurisdictionQuery(r)
	if !validID(account) || !validJurisdiction(jurisdiction) {
		writeError(w, 400, "invalid_bucket_location", "Invalid account or jurisdiction")
		return
	}
	result, err := s.cf.ListBuckets(r.Context(), token, account, jurisdiction, r.URL.Query().Get("cursor"))
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createBucket(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account := r.PathValue("account")
	var input struct {
		Name         string `json:"name"`
		Jurisdiction string `json:"jurisdiction"`
	}
	if !validID(account) || decodeJSON(w, r, &input) != nil || !validJurisdiction(input.Jurisdiction) || !validBucketName(input.Name) {
		writeError(w, 400, "invalid_bucket", "Invalid bucket request")
		return
	}
	result, err := s.cf.CreateBucket(r.Context(), token, account, input.Jurisdiction, input.Name)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) getBucket(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket, jurisdiction := r.PathValue("account"), r.PathValue("bucket"), jurisdictionQuery(r)
	if !validID(account) || !validBucketName(bucket) || !validJurisdiction(jurisdiction) {
		writeError(w, 400, "invalid_bucket", "Invalid bucket identifier")
		return
	}
	result, err := s.cf.GetBucket(r.Context(), token, account, jurisdiction, bucket)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteBucket(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket, jurisdiction := r.PathValue("account"), r.PathValue("bucket"), jurisdictionQuery(r)
	if !validID(account) || !validBucketName(bucket) || !validJurisdiction(jurisdiction) {
		writeError(w, 400, "invalid_bucket", "Invalid bucket identifier")
		return
	}
	if err := s.cf.DeleteBucket(r.Context(), token, account, jurisdiction, bucket); err != nil {
		s.upstreamError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) domains(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket, jurisdiction := r.PathValue("account"), r.PathValue("bucket"), jurisdictionQuery(r)
	if !validID(account) || !validBucketName(bucket) || !validJurisdiction(jurisdiction) {
		writeError(w, 400, "invalid_bucket", "Invalid bucket identifier")
		return
	}
	result, err := s.cf.ListDomains(r.Context(), token, account, jurisdiction, bucket)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) attachDomain(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket, jurisdiction := r.PathValue("account"), r.PathValue("bucket"), jurisdictionQuery(r)
	var input struct {
		Domain string `json:"domain"`
		ZoneID string `json:"zone_id"`
	}
	if !validID(account) || !validBucketName(bucket) || !validJurisdiction(jurisdiction) || decodeJSON(w, r, &input) != nil || !validDomain(input.Domain) || !validID(input.ZoneID) {
		writeError(w, 400, "invalid_domain", "Invalid custom domain request")
		return
	}
	if err := s.cf.AttachDomain(r.Context(), token, account, jurisdiction, bucket, input.Domain, input.ZoneID); err != nil {
		s.upstreamError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) detachDomain(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket, domain, jurisdiction := r.PathValue("account"), r.PathValue("bucket"), r.PathValue("domain"), jurisdictionQuery(r)
	if !validID(account) || !validBucketName(bucket) || !validJurisdiction(jurisdiction) || !validDomain(domain) {
		writeError(w, 400, "invalid_domain", "Invalid custom domain identifier")
		return
	}
	if err := s.cf.DetachDomain(r.Context(), token, account, jurisdiction, bucket, domain); err != nil {
		s.upstreamError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createCredential(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, bucket := r.PathValue("account"), r.PathValue("bucket")
	var input struct {
		Jurisdiction string `json:"jurisdiction"`
		ConnectionID string `json:"connection_id"`
		Permission   string `json:"permission"`
	}
	if !validID(account) || !validBucketName(bucket) || decodeJSON(w, r, &input) != nil || !validJurisdiction(input.Jurisdiction) || !validID(input.ConnectionID) || (input.Permission != "read-only" && input.Permission != "read-write") {
		writeError(w, 400, "invalid_credential", "Invalid credential request")
		return
	}
	result, err := s.cf.CreateCredential(r.Context(), token, account, input.Jurisdiction, bucket, input.ConnectionID, input.Permission)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) revokeCredential(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account := r.PathValue("account")
	var input struct {
		TokenID      string `json:"token_id"`
		ConnectionID string `json:"connection_id"`
	}
	if !validID(account) || decodeJSON(w, r, &input) != nil || !validID(input.TokenID) || !validID(input.ConnectionID) {
		writeError(w, 400, "invalid_credential", "Invalid credential revocation request")
		return
	}
	if err := s.cf.RevokeCredential(r.Context(), token, account, input.TokenID, input.ConnectionID); err != nil {
		s.upstreamError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) findCredential(w http.ResponseWriter, r *http.Request) {
	token, ok := s.bearer(w, r)
	if !ok {
		return
	}
	account, connectionID := r.PathValue("account"), r.URL.Query().Get("connection_id")
	if !validID(account) || !validID(connectionID) {
		writeError(w, 400, "invalid_credential", "Invalid credential lookup")
		return
	}
	id, err := s.cf.FindCredential(r.Context(), token, account, connectionID)
	if err != nil {
		s.upstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token_id": id})
}

func (s *Server) upstreamError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	var apiErr *cloudflare.APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == http.StatusUnauthorized && s.oauth != nil {
			s.oauth.ClearToken(w)
		}
		if apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusConflict || apiErr.Status == http.StatusTooManyRequests || (apiErr.Status >= 400 && apiErr.Status < 500) {
			status = apiErr.Status
		}
		writeError(w, status, "cloudflare_error", fmt.Sprintf("Cloudflare API: %s", apiErr.Message))
		return
	}
	writeError(w, status, "cloudflare_error", err.Error())
}

func (s *Server) corsAndCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		allowed := origin != "" && origin == s.cfg.FrontendOrigin
		if origin != "" {
			w.Header().Add("Vary", "Origin")
		}
		if origin != "" && !allowed {
			writeError(w, http.StatusForbidden, "origin_rejected", "Browser origin is not allowed")
			return
		}
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			if !allowed {
				writeError(w, http.StatusForbidden, "origin_rejected", "Browser origin is required")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodPost || r.Method == http.MethodDelete {
			if !allowed {
				writeError(w, http.StatusForbidden, "origin_rejected", "Browser origin is required")
				return
			}
			mediaType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
			if mediaType != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "content_type_required", "Mutations require application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func validID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func validBucketName(value string) bool {
	return len(value) >= 3 && len(value) <= 63 && strings.Trim(value, "abcdefghijklmnopqrstuvwxyz0123456789-") == "" && value[0] != '-' && value[len(value)-1] != '-'
}
func validJurisdiction(value string) bool {
	switch value {
	case "default", "eu", "us", "fedramp", "fedramp-high":
		return true
	}
	return false
}
func validDomain(value string) bool {
	u, err := url.Parse("https://" + value)
	return err == nil && u.Host == value && u.User == nil && !strings.Contains(value, "..") && len(value) <= 253
}
func jurisdictionQuery(r *http.Request) string {
	value := r.URL.Query().Get("jurisdiction")
	if value == "" {
		return "default"
	}
	return value
}

func staticHandler(directory string) http.Handler {
	root, err := filepath.Abs(directory)
	if err != nil {
		return http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean("/" + r.URL.Path)
		filename := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
		rel, err := filepath.Rel(root, filename)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			http.NotFound(w, r)
			return
		}
		info, err := os.Stat(filename)
		if err != nil || info.IsDir() {
			if strings.Contains(filepath.Base(clean), ".") {
				http.NotFound(w, r)
				return
			}
			filename = filepath.Join(root, "index.html")
		}
		http.ServeFile(w, r, filename)
	})
}
