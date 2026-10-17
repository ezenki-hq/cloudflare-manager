package server

import (
	"encoding/json"
	"net/http"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
)

type routeData struct {
	AccountID    string `json:"account_id"`
	Jurisdiction string `json:"jurisdiction"`
	Cursor       string `json:"cursor"`
	Bucket       string `json:"bucket"`
	Domain       string `json:"domain"`
	ZoneID       string `json:"zone_id"`
	Name         string `json:"name"`
	ConnectionID string `json:"connection_id"`
	Permission   string `json:"permission"`
	TokenID      string `json:"token_id"`
	ClientID     string `json:"client_id"`
	OpenerOrigin string `json:"opener_origin"`
	APIOrigin    string `json:"api_origin"`
}

func (s *Server) dispatch(w http.ResponseWriter, r *http.Request, raw json.RawMessage) error {
	var d routeData
	if err := decodeData(raw, &d); err != nil {
		return fail(http.StatusBadRequest, "invalid_request", "Invalid operation data")
	}
	if d.Jurisdiction == "" {
		d.Jurisdiction = "default"
	}
	switch r.URL.Path {
	case "/auth/start":
		if s.oauth == nil {
			return fail(http.StatusServiceUnavailable, "oauth_unavailable", "OAuth is unavailable")
		}
		u, err := s.oauth.Start(w, r, auth.StartInput{ClientID: d.ClientID, OpenerOrigin: d.OpenerOrigin, APIOrigin: d.APIOrigin})
		if err != nil {
			return fail(http.StatusBadRequest, "invalid_oauth_request", err.Error())
		}
		writeJSON(w, http.StatusOK, map[string]string{"authorization_url": u})
		return nil
	case "/api/session":
		if s.oauth == nil {
			return fail(http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
		}
		_, ok := s.oauth.Token(r)
		if !ok {
			return fail(http.StatusUnauthorized, "unauthorized", "Cloudflare sign-in is required")
		}
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
		return nil
	case "/api/accounts/list":
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.ListAccounts(r.Context(), t)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/zones/list":
		if !validID(d.AccountID) {
			return fail(400, "invalid_account", "Invalid account ID")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.ListZones(r.Context(), t, d.AccountID)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/buckets/list":
		if !validID(d.AccountID) {
			return fail(400, "invalid_bucket_location", "Invalid account or jurisdiction")
		}
		if d.Jurisdiction == "" {
			d.Jurisdiction = "default"
		}
		if !validJurisdiction(d.Jurisdiction) {
			return fail(400, "invalid_bucket_location", "Invalid account or jurisdiction")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.ListBuckets(r.Context(), t, d.AccountID, d.Jurisdiction, d.Cursor)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/buckets/get":
		if !validBucketInput(d) {
			return fail(400, "invalid_bucket", "Invalid bucket identifier")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.GetBucket(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/buckets/create":
		if !validBucketInput(d) {
			return fail(400, "invalid_bucket", "Invalid bucket request")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.CreateBucket(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusCreated, v)
		return nil
	case "/api/buckets/delete":
		if !validBucketInput(d) {
			return fail(400, "invalid_bucket", "Invalid bucket identifier")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		if e := s.cf.DeleteBucket(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket); e != nil {
			return s.upstreamError(w, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	case "/api/domains/list":
		if !validBucketInput(d) {
			return fail(400, "invalid_bucket", "Invalid bucket identifier")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.ListDomains(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/domains/attach":
		if !validBucketInput(d) || !validDomain(d.Domain) || !validID(d.ZoneID) {
			return fail(400, "invalid_domain", "Invalid custom domain request")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		if e := s.cf.AttachDomain(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket, d.Domain, d.ZoneID); e != nil {
			return s.upstreamError(w, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	case "/api/domains/detach":
		if !validBucketInput(d) || !validDomain(d.Domain) {
			return fail(400, "invalid_domain", "Invalid custom domain identifier")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		if e := s.cf.DetachDomain(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket, d.Domain); e != nil {
			return s.upstreamError(w, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	case "/api/credentials/create":
		if !validID(d.AccountID) || !validBucketName(d.Bucket) || !validJurisdiction(d.Jurisdiction) || !validID(d.ConnectionID) || (d.Permission != "read-only" && d.Permission != "read-write") {
			return fail(400, "invalid_credential", "Invalid credential request")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.CreateCredential(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket, d.ConnectionID, d.Permission)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, v)
		return nil
	case "/api/credentials/find":
		if !validID(d.AccountID) || !validID(d.ConnectionID) {
			return fail(400, "invalid_credential", "Invalid credential lookup")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		v, e := s.cf.FindCredential(r.Context(), t, d.AccountID, d.ConnectionID)
		if e != nil {
			return s.upstreamError(w, e)
		}
		writeJSON(w, http.StatusOK, map[string]string{"token_id": v})
		return nil
	case "/api/credentials/revoke":
		if !validID(d.AccountID) || !validID(d.TokenID) || !validID(d.ConnectionID) {
			return fail(400, "invalid_credential", "Invalid credential revocation request")
		}
		t, err := s.cloudflareToken(w, r)
		if err != nil {
			return err
		}
		if e := s.cf.RevokeCredential(r.Context(), t, d.AccountID, d.TokenID, d.ConnectionID); e != nil {
			return s.upstreamError(w, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	default:
		return fail(http.StatusNotFound, "not_found", "API route not found")
	}
}

func validBucketInput(d routeData) bool {
	return validID(d.AccountID) && validBucketName(d.Bucket) && validJurisdiction(d.Jurisdiction)
}
