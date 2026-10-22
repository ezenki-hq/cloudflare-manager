package manager

import (
	"context"
	"errors"
	"testing"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/cloudflare"
	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

type fakeCommander struct {
	resources         []commander.Resource
	resource          commander.ResourceDetail
	listResourcesErr  error
	getResourceErr    error
	createResourceErr error
	createResources   []commander.ResourceCreate
	connection        commander.ConnectionDetail
	connectionList    []commander.Connection
	deleted           []string
	labels            map[string]string
}
type fakeCloudflare struct {
	createErr bool
	revoked   []string
}

func (f *fakeCommander) ListMyResources(context.Context, string) ([]commander.Resource, error) {
	return f.resources, f.listResourcesErr
}
func (f *fakeCommander) GetResource(context.Context, string) (commander.ResourceDetail, error) {
	return f.resource, f.getResourceErr
}
func (f *fakeCommander) CreateResource(_ context.Context, input commander.ResourceCreate) (commander.ResourceDetail, error) {
	f.createResources = append(f.createResources, input)
	return f.resource, f.createResourceErr
}
func (f *fakeCommander) ListConnections(context.Context, string) ([]commander.Connection, error) {
	return append([]commander.Connection(nil), f.connectionList...), nil
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
	filtered := f.connectionList[:0]
	for _, item := range f.connectionList {
		if item.ID != id {
			filtered = append(filtered, item)
		}
	}
	f.connectionList = filtered
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

func TestPrepareTeardownFindsAndRevokesCredentialForPendingRecord(t *testing.T) {
	cc := &fakeCommander{resources: []commander.Resource{{ID: "r1", Manager: "manager-1", Type: ResourceType}}, resource: commander.ResourceDetail{Resource: commander.Resource{ID: "r1", Manager: "manager-1", Type: ResourceType}}, connection: commander.ConnectionDetail{Connection: commander.Connection{ID: "c1", Manager: "app-1", Resource: "r1"}, Config: commander.ConnectionConfig{Metadata: map[string]any{"status": "pending", "accountId": "account1"}}}, connectionList: []commander.Connection{{ID: "c1", Manager: "app-1", Resource: "r1"}}}
	cf := &fakeCloudflare{}
	s := NewService("manager-1", cc, cf)
	safe, err := s.PrepareTeardown(context.Background(), "oauth")
	if err != nil {
		t.Fatal(err)
	}
	if len(safe) != 1 || safe[0] != "r1" || len(cf.revoked) != 1 || len(cc.deleted) != 1 {
		t.Fatalf("safe=%v revoked=%v deleted=%v", safe, cf.revoked, cc.deleted)
	}
}

func TestPrepareTeardownLeavesResourcesWithUnmanagedConnections(t *testing.T) {
	cc := &fakeCommander{resources: []commander.Resource{{ID: "r1", Manager: "manager-1", Type: ResourceType}}, resource: commander.ResourceDetail{Resource: commander.Resource{ID: "r1", Manager: "manager-1", Type: ResourceType}}, connection: commander.ConnectionDetail{Connection: commander.Connection{ID: "external", Manager: "app-1", Resource: "r1"}, Config: commander.ConnectionConfig{Metadata: map[string]any{}}}, connectionList: []commander.Connection{{ID: "external", Manager: "app-1", Resource: "r1"}}}
	cc.connection.Connection.ID = "external"
	s := NewService("manager-1", cc, &fakeCloudflare{})
	safe, err := s.PrepareTeardown(context.Background(), "oauth")
	if err != nil {
		t.Fatal(err)
	}
	if len(safe) != 0 || len(cc.deleted) != 0 {
		t.Fatalf("unsafe resource returned: %v deleted=%v", safe, cc.deleted)
	}
}
