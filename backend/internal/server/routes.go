package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/auth"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
	managerpkg "github.com/ezenki-hq/cloudflare-manager/backend/internal/manager"
)

type routeData struct {
	AccountID     string            `json:"account_id"`
	Jurisdiction  string            `json:"jurisdiction"`
	Cursor        string            `json:"cursor"`
	Bucket        string            `json:"bucket"`
	Domain        string            `json:"domain"`
	ZoneID        string            `json:"zone_id"`
	Name          string            `json:"name"`
	ConnectionID  string            `json:"connection_id"`
	Permission    string            `json:"permission"`
	TokenID       string            `json:"token_id"`
	ClientID      string            `json:"client_id"`
	OpenerOrigin  string            `json:"opener_origin"`
	APIOrigin     string            `json:"api_origin"`
	ResourceID    string            `json:"resource_id"`
	S3Endpoint    string            `json:"s3_endpoint"`
	PrimaryDomain string            `json:"primary_domain"`
	ManagerID     string            `json:"manager_id"`
	GroupID       string            `json:"group_id"`
	Labels        map[string]string `json:"labels"`
	Connections   []string          `json:"connections"`
	Group         string            `json:"group"`
}

func (s *Server) dispatch(w http.ResponseWriter, r *http.Request, raw json.RawMessage) error {
	allowed, exists := routeFields[r.URL.Path]
	if !exists {
		return fail(http.StatusNotFound, "not_found", "API route not found")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return fail(http.StatusBadRequest, "invalid_request", "Invalid operation data")
	}
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return fail(http.StatusBadRequest, "invalid_request", "Invalid operation data")
		}
	}
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
			if errors.Is(err, auth.ErrStateStoreUnavailable) {
				return fail(http.StatusServiceUnavailable, "commander_unavailable", "Commander database is unavailable; try signing in again shortly")
			}
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
		if s.manager != nil {
			if e := s.manager.DeleteBucket(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket); e != nil {
				return s.upstreamError(w, r, e)
			}
		} else if e := s.cf.DeleteBucket(r.Context(), t, d.AccountID, d.Jurisdiction, d.Bucket); e != nil {
			return s.upstreamError(w, r, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	case "/api/resources/find":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		if !validID(d.AccountID) || !validBucketName(d.Bucket) || !validJurisdiction(d.Jurisdiction) {
			return fail(400, "invalid_resource", "Invalid R2 resource lookup")
		}
		resource, e := s.manager.FindResource(r.Context(), d.AccountID, d.Jurisdiction, d.Bucket)
		if e != nil {
			return fail(502, "commander_error", e.Error())
		}
		writeJSON(w, http.StatusOK, resource)
		return nil
	case "/api/resources/register":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		if !validID(d.AccountID) || !validBucketName(d.Bucket) || !validJurisdiction(d.Jurisdiction) {
			return fail(400, "invalid_resource", "Invalid R2 resource")
		}
		id, e := s.manager.RegisterResource(r.Context(), managerpkg.ResourceInput{AccountID: d.AccountID, Jurisdiction: d.Jurisdiction, Bucket: d.Bucket, Endpoint: d.S3Endpoint, PrimaryDomain: d.PrimaryDomain})
		if e != nil {
			return fail(502, "commander_error", e.Error())
		}
		writeJSON(w, http.StatusCreated, map[string]string{"resource_id": id})
		return nil
	case "/api/connections/list":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		items, e := s.manager.ListConnections(r.Context(), d.ResourceID)
		if e != nil {
			return fail(502, "commander_error", e.Error())
		}
		safe := make([]map[string]any, 0, len(items))
		for _, item := range items {
			safe = append(safe, safeConnection(item))
		}
		writeJSON(w, http.StatusOK, safe)
		return nil
	case "/api/connections/provision":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		token, e := s.cloudflareToken(w, r)
		if e != nil {
			return e
		}
		groupID := ""
		if len(d.Labels) > 0 {
			if d.Labels[managerpkg.OriginLabel] != managerpkg.OriginCreated || len(d.Labels) != 2 {
				return fail(400, "invalid_labels", "Invalid created connection labels")
			}
			groupID = d.Labels[managerpkg.GroupLabel]
		}
		result, e := s.manager.Provision(r.Context(), token, managerpkg.ProvisionInput{ResourceID: d.ResourceID, ManagerID: d.ManagerID, Permission: d.Permission, GroupID: groupID})
		if e != nil {
			return fail(502, "provision_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, result)
		return nil
	case "/api/connections/confirm":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		item, e := s.manager.Confirm(r.Context(), d.ConnectionID)
		if e != nil {
			return fail(502, "confirm_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, safeConnection(item))
		return nil
	case "/api/connections/abort", "/api/connections/revoke":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		token, e := s.cloudflareToken(w, r)
		if e != nil {
			return e
		}
		var cleanup error
		if r.URL.Path == "/api/connections/abort" {
			cleanup = s.manager.Abort(r.Context(), token, d.ConnectionID)
		} else {
			cleanup = s.manager.Revoke(r.Context(), token, d.ConnectionID)
		}
		if cleanup != nil {
			return fail(502, "cleanup_failed", cleanup.Error())
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	case "/api/connections/link":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		item, e := s.manager.Link(r.Context(), d.ResourceID, d.ConnectionID, d.Labels)
		if e != nil {
			return fail(400, "link_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, safeConnection(item))
		return nil
	case "/api/connections/unlink":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		item, e := s.manager.Unlink(r.Context(), d.ResourceID, d.ConnectionID, d.Group)
		if e != nil {
			return fail(400, "unlink_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, safeConnection(item))
		return nil
	case "/api/connections/delete-group":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		token, e := s.cloudflareToken(w, r)
		if e != nil {
			return e
		}
		deleted, e := s.manager.DeleteGroup(r.Context(), token, d.Connections)
		if e != nil {
			return fail(502, "delete_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, map[string][]string{"deleted": deleted})
		return nil
	case "/api/teardown/prepare":
		if s.manager == nil {
			return fail(503, "commander_unavailable", "Commander is unavailable")
		}
		token, e := s.cloudflareToken(w, r)
		if e != nil {
			return e
		}
		ids, e := s.manager.PrepareTeardown(r.Context(), token)
		if e != nil {
			return fail(502, "teardown_failed", e.Error())
		}
		writeJSON(w, http.StatusOK, map[string][]string{"resource_ids": ids})
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
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
			return s.upstreamError(w, r, e)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	default:
		return fail(http.StatusNotFound, "not_found", "API route not found")
	}
}

var routeFields = map[string]map[string]struct{}{
	"/auth/start":                   fieldSet("client_id", "opener_origin", "api_origin"),
	"/api/session":                  fieldSet(),
	"/api/accounts/list":            fieldSet(),
	"/api/zones/list":               fieldSet("account_id"),
	"/api/buckets/list":             fieldSet("account_id", "jurisdiction", "cursor"),
	"/api/buckets/get":              fieldSet("account_id", "jurisdiction", "bucket"),
	"/api/buckets/create":           fieldSet("account_id", "jurisdiction", "bucket"),
	"/api/buckets/delete":           fieldSet("account_id", "jurisdiction", "bucket"),
	"/api/domains/list":             fieldSet("account_id", "jurisdiction", "bucket"),
	"/api/domains/attach":           fieldSet("account_id", "jurisdiction", "bucket", "domain", "zone_id"),
	"/api/domains/detach":           fieldSet("account_id", "jurisdiction", "bucket", "domain"),
	"/api/credentials/create":       fieldSet("account_id", "bucket", "jurisdiction", "connection_id", "permission"),
	"/api/credentials/find":         fieldSet("account_id", "connection_id"),
	"/api/credentials/revoke":       fieldSet("account_id", "token_id", "connection_id"),
	"/api/resources/find":           fieldSet("account_id", "jurisdiction", "bucket"),
	"/api/resources/register":       fieldSet("account_id", "jurisdiction", "bucket", "s3_endpoint", "primary_domain"),
	"/api/connections/list":         fieldSet("resource_id"),
	"/api/connections/provision":    fieldSet("resource_id", "manager_id", "permission", "labels"),
	"/api/connections/confirm":      fieldSet("connection_id"),
	"/api/connections/abort":        fieldSet("connection_id"),
	"/api/connections/revoke":       fieldSet("connection_id"),
	"/api/connections/link":         fieldSet("resource_id", "connection_id", "labels"),
	"/api/connections/unlink":       fieldSet("resource_id", "connection_id", "group"),
	"/api/connections/delete-group": fieldSet("connections"),
	"/api/teardown/prepare":         fieldSet(),
}

func fieldSet(fields ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		out[field] = struct{}{}
	}
	return out
}

func safeConnection(d commander.ConnectionDetail) map[string]any {
	m := d.Config.Metadata
	metadata := map[string]any{}
	for _, key := range []string{"status", "permission", "accountId", "bucket", "jurisdiction", "endpoint", "secret_keys"} {
		if value, ok := m[key]; ok {
			metadata[key] = value
		}
	}
	return map[string]any{"connection": map[string]any{"id": d.Connection.ID, "manager": d.Connection.Manager, "resource": d.Connection.Resource, "labels": d.Connection.Labels, "metadata": metadata}}
}

func validBucketInput(d routeData) bool {
	return validID(d.AccountID) && validBucketName(d.Bucket) && validJurisdiction(d.Jurisdiction)
}
