package manager

import (
	"context"
	"errors"
	"testing"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

type fakeCommander struct {
	resources  []commander.Resource
	resource   commander.ResourceDetail
	connection commander.ConnectionDetail
	deleted    []string
	labels     map[string]string
}
type fakeCloudflare struct {
	createErr bool
	revoked   []string
}

func (f *fakeCommander) ListMyResources(context.Context, string) ([]commander.Resource, error) {
	return f.resources, nil
}
func (f *fakeCommander) GetResource(context.Context, string) (commander.ResourceDetail, error) {
	return f.resource, nil
}
func (f *fakeCommander) CreateResource(context.Context, commander.ResourceCreate) (commander.ResourceDetail, error) {
	return f.resource, nil
}
func (f *fakeCommander) ListConnections(context.Context, string) ([]commander.Connection, error) {
	return nil, nil
}
func (f *fakeCommander) GetConnection(context.Context, string) (commander.ConnectionDetail, error) {
	return f.connection, nil
}
func (f *fakeCommander) CreateConnection(_ context.Context, input commander.ConnectionCreate) (commander.ConnectionDetail, error) {
	f.connection = commander.ConnectionDetail{Connection: commander.Connection{ID: "c1", Manager: input.ManagerID, Resource: input.ResourceID}, Config: commander.ConnectionConfig{Metadata: input.Metadata}}
	return f.connection, nil
}
func (f *fakeCommander) UpdateConnection(_ context.Context, _ string, metadata any) error {
	if m, ok := metadata.(map[string]any); ok {
		f.connection.Config.Metadata = m
	}
	return nil
}
func (f *fakeCommander) DeleteConnection(_ context.Context, id string) error {
	f.deleted = append(f.deleted, id)
	return nil
}
func (f *fakeCommander) PutConnectionLabel(_ context.Context, _, key, value string) error {
	if f.labels == nil {
		f.labels = map[string]string{}
	}
	f.labels[key] = value
	if f.connection.Connection.Labels == nil {
		f.connection.Connection.Labels = map[string]string{}
	}
	f.connection.Connection.Labels[key] = value
	return nil
}
func (f *fakeCommander) DeleteConnectionLabel(_ context.Context, _, key string) error {
	delete(f.labels, key)
	delete(f.connection.Connection.Labels, key)
	return nil
}
func (f *fakeCloudflare) CreateCredential(context.Context, string, string, string, string, string, string) (cloudflare.Credential, error) {
	if f.createErr {
		return cloudflare.Credential{}, errors.New("Cloudflare failed")
	}
	return cloudflare.Credential{TokenID: "token-1", AccessKeyID: "key-id", SecretAccessKey: "secret-key"}, nil
}
func (f *fakeCloudflare) RevokeCredential(_ context.Context, _, _, token, _ string) error {
	f.revoked = append(f.revoked, token)
	return nil
}
func (f *fakeCloudflare) FindCredential(context.Context, string, string, string) (string, error) {
	return "token-1", nil
}
func (f *fakeCloudflare) DeleteBucket(context.Context, string, string, string, string) error {
	return nil
}

func TestFindResourceRejectsResourceOutsideManagerOwnership(t *testing.T) {
	cc := &fakeCommander{resources: []commander.Resource{{ID: "r1", Manager: "other", Type: ResourceType}}}
	s := NewService("manager-1", cc, nil)
	if _, err := s.FindResource(context.Background(), "account1", "default", "bucket-one"); err == nil {
		t.Fatal("accepted a foreign-owned resource")
	}
}

func TestLinkRejectsWrongResourceAndPreservesUnrelatedLabels(t *testing.T) {
	cc := &fakeCommander{resource: commander.ResourceDetail{Resource: commander.Resource{ID: "r1", Manager: "manager-1", Type: ResourceType}}, connection: commander.ConnectionDetail{Connection: commander.Connection{ID: "c1", Manager: "app-1", Resource: "other-resource", Labels: map[string]string{"keep": "value"}}}}
	s := NewService("manager-1", cc, nil)
	if _, err := s.Link(context.Background(), "r1", "c1", map[string]string{GroupLabel: "g1", OriginLabel: OriginImported}); err == nil {
		t.Fatal("linked connection attached to another resource")
	}
	if cc.connection.Connection.Labels["keep"] != "value" || len(cc.labels) != 0 {
		t.Fatalf("labels changed: %v", cc.labels)
	}
}

func TestProvisionPersistsPendingTokenAndConfirmAddsKeysAfterHandoff(t *testing.T) {
	cc := &fakeCommander{resource: commander.ResourceDetail{Resource: commander.Resource{ID: "r1", Manager: "manager-1", Type: ResourceType}, Config: commander.ResourceConfig{Metadata: map[string]any{"account_id": "account1", "bucket": "bucket-one", "jurisdiction": "default", "s3_endpoint": "https://account.r2.test"}}}}
	s := NewService("manager-1", cc, &fakeCloudflare{})
	result, err := s.Provision(context.Background(), "oauth-token", ProvisionInput{ResourceID: "r1", ManagerID: "app-1", Permission: "read-write", GroupID: "group-1"})
	if err != nil {
		t.Fatal(err)
	}
	if result.ConnectionID != "c1" || result.TokenID != "token-1" || result.AccessKeyID != "key-id" || result.SecretAccessKey != "secret-key" {
		t.Fatalf("unexpected result %#v", result)
	}
	if cc.connection.Config.Metadata["status"] != "pending" || cc.connection.Config.Metadata["token_id"] != "token-1" {
		t.Fatalf("pending token not saved: %v", cc.connection.Config.Metadata)
	}
	if _, ok := cc.connection.Config.Metadata["secret_keys"]; ok || len(cc.connection.Connection.Labels) != 0 {
		t.Fatalf("pending connection exposed ready state: %#v", cc.connection)
	}
	ready, err := s.Confirm(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	keys, ok := ready.Config.Metadata["secret_keys"].([]string)
	if !ok || len(keys) != 2 || keys[0] != secretAccessKey || keys[1] != secretSecretKey {
		t.Fatalf("secret key declarations=%#v", ready.Config.Metadata["secret_keys"])
	}
	if ready.Config.Metadata["status"] != "ready" || ready.Connection.Labels[GroupLabel] != "group-1" || ready.Connection.Labels[OriginLabel] != OriginCreated {
		t.Fatalf("connection not ready: %#v", ready)
	}
}

func TestProvisionCloudflareFailureDeletesPendingConnection(t *testing.T) {
	cc := &fakeCommander{resource: commander.ResourceDetail{Resource: commander.Resource{ID: "r1", Manager: "manager-1", Type: ResourceType}, Config: commander.ResourceConfig{Metadata: map[string]any{"account_id": "account1", "bucket": "bucket-one", "jurisdiction": "default", "s3_endpoint": "https://account.r2.test"}}}}
	s := NewService("manager-1", cc, &fakeCloudflare{createErr: true})
	if _, err := s.Provision(context.Background(), "token", ProvisionInput{ResourceID: "r1", ManagerID: "app-1", Permission: "read-only"}); err == nil {
		t.Fatal("expected Cloudflare failure")
	}
	if len(cc.deleted) != 1 || cc.deleted[0] != "c1" {
		t.Fatalf("pending connection not removed: %v", cc.deleted)
	}
}
