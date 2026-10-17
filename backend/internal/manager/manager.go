package manager

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

const (
	ResourceType    = "cloudflare-r2-bucket"
	GroupLabel      = "custom_deployer_group_id"
	OriginLabel     = "custom_deployer_connection_origin"
	OriginCreated   = "created"
	OriginImported  = "imported"
	secretAccessKey = "AWS_ACCESS_KEY_ID"
	secretSecretKey = "AWS_SECRET_ACCESS_KEY"
)

type Commander interface {
	ListMyResources(context.Context, string) ([]commander.Resource, error)
	GetResource(context.Context, string) (commander.ResourceDetail, error)
	CreateResource(context.Context, commander.ResourceCreate) (commander.ResourceDetail, error)
	ListConnections(context.Context, string) ([]commander.Connection, error)
	GetConnection(context.Context, string) (commander.ConnectionDetail, error)
	CreateConnection(context.Context, commander.ConnectionCreate) (commander.ConnectionDetail, error)
	UpdateConnection(context.Context, string, any) error
	DeleteConnection(context.Context, string) error
	PutConnectionLabel(context.Context, string, string, string) error
	DeleteConnectionLabel(context.Context, string, string) error
}
type Cloudflare interface {
	CreateCredential(context.Context, string, string, string, string, string, string) (cloudflare.Credential, error)
	RevokeCredential(context.Context, string, string, string, string) error
	FindCredential(context.Context, string, string, string) (string, error)
	DeleteBucket(context.Context, string, string, string, string) error
}
type Service struct {
	managerID  string
	commander  Commander
	cloudflare Cloudflare
}
type ResourceInput struct {
	AccountID     string `json:"account_id"`
	Jurisdiction  string `json:"jurisdiction"`
	Bucket        string `json:"bucket"`
	Endpoint      string `json:"s3_endpoint"`
	PrimaryDomain string `json:"primary_domain,omitempty"`
}
type ProvisionInput struct {
	ResourceID string `json:"resource_id"`
	ManagerID  string `json:"manager_id"`
	Permission string `json:"permission"`
	GroupID    string `json:"group_id,omitempty"`
}
type ProvisionResult struct {
	ConnectionID    string `json:"connection_id"`
	TokenID         string `json:"token_id"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
}
type ConnectionMetadata struct {
	Status       string   `json:"status"`
	TokenID      string   `json:"token_id,omitempty"`
	Permission   string   `json:"permission"`
	AccountID    string   `json:"accountId"`
	Bucket       string   `json:"bucket"`
	Jurisdiction string   `json:"jurisdiction"`
	Endpoint     string   `json:"endpoint"`
	SecretKeys   []string `json:"secret_keys,omitempty"`
	GroupID      string   `json:"pending_group_id,omitempty"`
}

func NewService(managerID string, c Commander, cf Cloudflare) *Service {
	return &Service{managerID: managerID, commander: c, cloudflare: cf}
}

func (s *Service) FindResource(ctx context.Context, accountID, jurisdiction, bucket string) (*commander.ResourceDetail, error) {
	items, err := s.commander.ListMyResources(ctx, ResourceType)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Manager != s.managerID || item.Type != ResourceType {
			return nil, errors.New("Commander returned resource outside manager ownership")
		}
		detail, err := s.commander.GetResource(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if err := s.validateResource(detail, item.ID); err != nil {
			return nil, err
		}
		meta := detail.Config.Metadata
		if stringValue(meta["account_id"]) == accountID && stringValue(meta["bucket"]) == bucket && stringValue(meta["jurisdiction"]) == jurisdiction {
			return &detail, nil
		}
	}
	return nil, nil
}

func (s *Service) RegisterResource(ctx context.Context, input ResourceInput) (string, error) {
	if input.Jurisdiction == "" {
		input.Jurisdiction = "default"
	}
	if !validAccount(input.AccountID) || !validBucket(input.Bucket) || !validJurisdiction(input.Jurisdiction) || !validEndpoint(input.Endpoint) {
		return "", errors.New("invalid R2 resource input")
	}
	if input.PrimaryDomain != "" && !validDomain(input.PrimaryDomain) {
		return "", errors.New("invalid primary domain")
	}
	found, err := s.FindResource(ctx, input.AccountID, input.Jurisdiction, input.Bucket)
	if err != nil {
		return "", err
	}
	if found != nil {
		return found.Resource.ID, nil
	}
	metadata := map[string]any{"account_id": input.AccountID, "bucket": input.Bucket, "jurisdiction": input.Jurisdiction, "s3_endpoint": input.Endpoint}
	if input.PrimaryDomain != "" {
		metadata["primary_domain"] = input.PrimaryDomain
	}
	detail, err := s.commander.CreateResource(ctx, commander.ResourceCreate{Name: "Cloudflare R2 · " + input.Bucket, Type: ResourceType, External: true, Metadata: metadata})
	if err != nil {
		return "", err
	}
	if err := s.validateResource(detail, detail.Resource.ID); err != nil {
		return "", err
	}
	return detail.Resource.ID, nil
}

func (s *Service) ListConnections(ctx context.Context, resourceID string) ([]commander.ConnectionDetail, error) {
	if _, err := s.ownedResource(ctx, resourceID); err != nil {
		return nil, err
	}
	items, err := s.commander.ListConnections(ctx, resourceID)
	if err != nil {
		return nil, err
	}
	out := make([]commander.ConnectionDetail, 0, len(items))
	for _, item := range items {
		detail, err := s.commander.GetConnection(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if detail.Connection.Resource != resourceID {
			return nil, errors.New("Commander connection is attached to another resource")
		}
		out = append(out, detail)
	}
	return out, nil
}

func (s *Service) Provision(ctx context.Context, cfToken string, input ProvisionInput) (ProvisionResult, error) {
	var result ProvisionResult
	if input.ManagerID == "" || input.ManagerID == s.managerID || !safeCommanderID(input.ManagerID) || (input.Permission != "read-only" && input.Permission != "read-write") {
		return result, errors.New("invalid connection beneficiary or permission")
	}
	resource, err := s.ownedResource(ctx, input.ResourceID)
	if err != nil {
		return result, err
	}
	meta := resource.Config.Metadata
	account, bucket, jurisdiction := stringValue(meta["account_id"]), stringValue(meta["bucket"]), stringValue(meta["jurisdiction"])
	endpoint := stringValue(meta["s3_endpoint"])
	if !validAccount(account) || !validBucket(bucket) || !validJurisdiction(jurisdiction) || !validEndpoint(endpoint) {
		return result, errors.New("R2 resource metadata is incomplete")
	}
	if input.GroupID != "" && !safeLabel(input.GroupID) {
		return result, errors.New("invalid group identifier")
	}
	if err := s.reconcilePending(ctx, cfToken, input.ResourceID, input.ManagerID, account); err != nil {
		return result, err
	}
	pending := map[string]any{"status": "pending", "permission": input.Permission, "accountId": account, "bucket": bucket, "jurisdiction": jurisdiction, "endpoint": endpoint}
	if input.GroupID != "" {
		pending["pending_group_id"] = input.GroupID
	}
	detail, err := s.commander.CreateConnection(ctx, commander.ConnectionCreate{ManagerID: input.ManagerID, ResourceID: input.ResourceID, Metadata: pending})
	if err != nil {
		return result, err
	}
	id := detail.Connection.ID
	credential, err := s.cloudflare.CreateCredential(ctx, cfToken, account, jurisdiction, bucket, id, input.Permission)
	if err != nil {
		_ = s.commander.DeleteConnection(ctx, id)
		return result, err
	}
	pending["token_id"] = credential.TokenID
	if err := s.commander.UpdateConnection(ctx, id, pending); err != nil {
		revokeErr := s.cloudflare.RevokeCredential(ctx, cfToken, account, credential.TokenID, id)
		if revokeErr == nil {
			_ = s.commander.DeleteConnection(ctx, id)
		}
		return result, fmt.Errorf("save pending Cloudflare token reference: %w", err)
	}
	return ProvisionResult{ConnectionID: id, TokenID: credential.TokenID, AccessKeyID: credential.AccessKeyID, SecretAccessKey: credential.SecretAccessKey}, nil
}

func (s *Service) Confirm(ctx context.Context, connectionID string) (commander.ConnectionDetail, error) {
	detail, err := s.commander.GetConnection(ctx, connectionID)
	if err != nil {
		return detail, err
	}
	if _, err = s.ownedResource(ctx, detail.Connection.Resource); err != nil {
		return detail, err
	}
	metadata := detail.Config.Metadata
	status := stringValue(metadata["status"])
	if (status != "pending" && status != "ready") || stringValue(metadata["token_id"]) == "" {
		return detail, errors.New("connection is not pending secret handoff")
	}
	metadata["status"] = "ready"
	metadata["secret_keys"] = []string{secretAccessKey, secretSecretKey}
	group := stringValue(metadata["pending_group_id"])
	delete(metadata, "pending_group_id")
	if status != "ready" {
		if err := s.commander.UpdateConnection(ctx, connectionID, metadata); err != nil {
			return detail, err
		}
	}
	if group != "" {
		if err := s.commander.PutConnectionLabel(ctx, connectionID, OriginLabel, OriginCreated); err != nil {
			return detail, err
		}
		if err := s.commander.PutConnectionLabel(ctx, connectionID, GroupLabel, group); err != nil {
			return detail, err
		}
	}
	return s.commander.GetConnection(ctx, connectionID)
}

func (s *Service) Abort(ctx context.Context, cfToken, connectionID string) error {
	return s.deleteOne(ctx, cfToken, connectionID, false)
}
func (s *Service) Revoke(ctx context.Context, cfToken, connectionID string) error {
	return s.deleteOne(ctx, cfToken, connectionID, true)
}
func (s *Service) deleteOne(ctx context.Context, cfToken, id string, requireCreated bool) error {
	detail, err := s.commander.GetConnection(ctx, id)
	if err != nil {
		return err
	}
	if _, err = s.ownedResource(ctx, detail.Connection.Resource); err != nil {
		return err
	}
	m := detail.Config.Metadata
	if requireCreated && stringValue(detail.Connection.Labels[OriginLabel]) != OriginCreated {
		return errors.New("refusing to delete a connection not created for a group")
	}
	account, tokenID := stringValue(m["accountId"]), stringValue(m["token_id"])
	if tokenID != "" {
		if err := s.cloudflare.RevokeCredential(ctx, cfToken, account, tokenID, id); err != nil {
			delete(m, "secret_keys")
			m["status"] = "revoke_failed"
			_ = s.commander.UpdateConnection(ctx, id, m)
			return err
		}
	}
	return s.commander.DeleteConnection(ctx, id)
}

func (s *Service) reconcilePending(ctx context.Context, cfToken, resourceID, beneficiary, account string) error {
	items, err := s.commander.ListConnections(ctx, resourceID)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Manager != beneficiary {
			continue
		}
		detail, err := s.commander.GetConnection(ctx, item.ID)
		if err != nil {
			return err
		}
		metadata := detail.Config.Metadata
		if stringValue(metadata["status"]) != "pending" {
			continue
		}
		tokenID := stringValue(metadata["token_id"])
		if tokenID == "" {
			tokenID, err = s.cloudflare.FindCredential(ctx, cfToken, account, item.ID)
			if err != nil {
				return err
			}
		}
		if tokenID != "" {
			if err := s.cloudflare.RevokeCredential(ctx, cfToken, account, tokenID, item.ID); err != nil {
				return fmt.Errorf("revoke abandoned pending credential: %w", err)
			}
		}
		if err := s.commander.DeleteConnection(ctx, item.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) Link(ctx context.Context, resourceID, connectionID string, labels map[string]string) (commander.ConnectionDetail, error) {
	if err := validateLabels(labels, OriginImported); err != nil {
		return commander.ConnectionDetail{}, err
	}
	if _, err := s.ownedResource(ctx, resourceID); err != nil {
		return commander.ConnectionDetail{}, err
	}
	d, err := s.commander.GetConnection(ctx, connectionID)
	if err != nil {
		return d, err
	}
	if d.Connection.Resource != resourceID {
		return d, errors.New("connection is attached to another resource")
	}
	if d.Connection.Labels[GroupLabel] != "" {
		return d, errors.New("connection already belongs to a group")
	}
	if err := s.commander.PutConnectionLabel(ctx, connectionID, OriginLabel, OriginImported); err != nil {
		return d, err
	}
	if err := s.commander.PutConnectionLabel(ctx, connectionID, GroupLabel, labels[GroupLabel]); err != nil {
		_ = s.commander.DeleteConnectionLabel(ctx, connectionID, OriginLabel)
		return d, err
	}
	return s.commander.GetConnection(ctx, connectionID)
}

func (s *Service) Unlink(ctx context.Context, resourceID, connectionID, group string) (commander.ConnectionDetail, error) {
	if _, err := s.ownedResource(ctx, resourceID); err != nil {
		return commander.ConnectionDetail{}, err
	}
	d, err := s.commander.GetConnection(ctx, connectionID)
	if err != nil {
		return d, err
	}
	if d.Connection.Resource != resourceID || d.Connection.Labels[GroupLabel] != group || d.Connection.Labels[OriginLabel] != OriginImported {
		return d, errors.New("connection is not an imported member of this group")
	}
	if err := s.commander.DeleteConnectionLabel(ctx, connectionID, GroupLabel); err != nil {
		return d, err
	}
	if err := s.commander.DeleteConnectionLabel(ctx, connectionID, OriginLabel); err != nil {
		return d, err
	}
	return s.commander.GetConnection(ctx, connectionID)
}

func (s *Service) DeleteGroup(ctx context.Context, cfToken string, ids []string) ([]string, error) {
	done := []string{}
	for _, id := range ids {
		d, err := s.commander.GetConnection(ctx, id)
		if err != nil {
			return done, err
		}
		if _, err = s.ownedResource(ctx, d.Connection.Resource); err != nil {
			return done, err
		}
		if err = s.deleteOne(ctx, cfToken, id, true); err != nil {
			return done, err
		}
		done = append(done, id)
	}
	return done, nil
}

func (s *Service) DeleteBucket(ctx context.Context, cfToken, accountID, jurisdiction, bucket string) error {
	resource, err := s.FindResource(ctx, accountID, jurisdiction, bucket)
	if err != nil {
		return err
	}
	if resource != nil {
		connections, err := s.commander.ListConnections(ctx, resource.Resource.ID)
		if err != nil {
			return err
		}
		for _, c := range connections {
			d, err := s.commander.GetConnection(ctx, c.ID)
			if err != nil {
				return err
			}
			if _, ok := d.Config.Metadata["token_id"]; !ok {
				return errors.New("bucket has an unmanaged connection; refusing deletion")
			}
			if err := s.deleteOne(ctx, cfToken, c.ID, false); err != nil {
				return err
			}
		}
	}
	return s.cloudflare.DeleteBucket(ctx, cfToken, accountID, jurisdiction, bucket)
}

func (s *Service) PrepareTeardown(ctx context.Context, cfToken string) ([]string, error) {
	resources, err := s.commander.ListMyResources(ctx, ResourceType)
	if err != nil {
		return nil, err
	}
	safe := []string{}
	for _, r := range resources {
		if r.Manager != s.managerID || r.Type != ResourceType {
			return nil, errors.New("resource ownership check failed")
		}
		connections, err := s.commander.ListConnections(ctx, r.ID)
		if err != nil {
			return nil, err
		}
		for _, c := range connections {
			d, err := s.commander.GetConnection(ctx, c.ID)
			if err != nil {
				return nil, err
			}
			if _, ok := d.Config.Metadata["token_id"]; ok {
				if err := s.deleteOne(ctx, cfToken, c.ID, false); err != nil {
					return nil, err
				}
			}
		}
		remaining, err := s.commander.ListConnections(ctx, r.ID)
		if err != nil {
			return nil, err
		}
		if len(remaining) == 0 {
			safe = append(safe, r.ID)
		}
	}
	return safe, nil
}

func (s *Service) ownedResource(ctx context.Context, id string) (commander.ResourceDetail, error) {
	d, err := s.commander.GetResource(ctx, id)
	if err != nil {
		return d, err
	}
	return d, s.validateResource(d, id)
}
func (s *Service) validateResource(d commander.ResourceDetail, id string) error {
	if id == "" || d.Resource.ID != id || d.Resource.Manager != s.managerID || d.Resource.Type != ResourceType {
		return errors.New("resource is not owned by this manager")
	}
	return nil
}
func stringValue(v any) string   { x, _ := v.(string); return x }
func validAccount(s string) bool { return safeCommanderID(s) }
func validBucket(s string) bool {
	return len(s) >= 3 && len(s) <= 63 && strings.Trim(s, "abcdefghijklmnopqrstuvwxyz0123456789-") == "" && s[0] != '-' && s[len(s)-1] != '-'
}
func validJurisdiction(s string) bool {
	switch s {
	case "default", "eu", "us", "fedramp", "fedramp-high":
		return true
	}
	return false
}
func validEndpoint(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}
func validDomain(s string) bool {
	return len(s) > 0 && len(s) <= 253 && !strings.ContainsAny(s, "/:@?# ")
}
func safeCommanderID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
func safeLabel(s string) bool { return len(s) > 0 && len(s) <= 128 && !strings.ContainsAny(s, "\r\n") }
func validateLabels(labels map[string]string, origin string) error {
	if labels[OriginLabel] != origin || !safeLabel(labels[GroupLabel]) || len(labels) != 2 {
		return errors.New("invalid group labels")
	}
	return nil
}
