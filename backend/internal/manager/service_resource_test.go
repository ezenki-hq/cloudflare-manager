package manager

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

func TestEnsureServiceResourceCreatesAndReuses(t *testing.T) {
	metadata := map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1}
	cc := &fakeCommander{resource: commander.ResourceDetail{
		Resource: commander.Resource{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true},
		Config:   commander.ResourceConfig{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", Metadata: metadata},
	}}
	s := NewService("manager-1", cc, nil)

	firstID, err := s.EnsureServiceResource(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	input := cc.createResources[0]
	if input.Type != "s3" || input.Name != "Cloudflare R2 S3" || !input.External {
		t.Fatalf("wrong resource: %#v", input)
	}
	if !reflect.DeepEqual(input.Metadata, metadata) {
		t.Fatalf("metadata = %#v, want %#v", input.Metadata, metadata)
	}
	for _, key := range []string{"account_id", "bucket", "s3_endpoint", "primary_domain", "secret", "token"} {
		if _, exists := input.Metadata[key]; exists {
			t.Fatalf("service resource must not contain %q", key)
		}
	}

	cc.resources = []commander.Resource{cc.resource.Resource}
	secondID, err := s.EnsureServiceResource(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if firstID != "service-1" || secondID != firstID || len(cc.createResources) != 1 {
		t.Fatalf("IDs = %q, %q; create calls = %d", firstID, secondID, len(cc.createResources))
	}
}

func TestEnsureServiceResourceLogsCreateAndReuseStages(t *testing.T) {
	cc := &fakeCommander{resource: commander.ResourceDetail{
		Resource: commander.Resource{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true},
		Config:   commander.ResourceConfig{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", Metadata: cloneServiceResourceMetadata()},
	}}
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	s := NewService("manager-1", cc, nil)
	if _, err := s.EnsureServiceResource(context.Background()); err != nil {
		t.Fatal(err)
	}
	cc.resources = []commander.Resource{cc.resource.Resource}
	if _, err := s.EnsureServiceResource(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"s3_provisioner_lookup_started", "s3_provisioner_create_started", "s3_provisioner_created", "s3_provisioner_reuse_started", "s3_provisioner_reused"} {
		if !strings.Contains(logs.String(), `stage=`+stage) {
			t.Errorf("logs missing stage %q: %s", stage, logs.String())
		}
	}
	for _, sensitive := range []string{"service-1", "manager-1", "cloudflare-r2"} {
		if strings.Contains(logs.String(), sensitive) {
			t.Errorf("logs contain resource detail %q: %s", sensitive, logs.String())
		}
	}
}

func TestValidateServiceResourceReportsFixedFieldPath(t *testing.T) {
	base := commander.ResourceDetail{
		Resource: commander.Resource{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true},
		Config:   commander.ResourceConfig{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", Metadata: map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1}},
	}
	for _, test := range []struct {
		name      string
		mutate    func(*commander.ResourceDetail)
		wantPath  string
		forbidden string
	}{
		{name: "missing resource type", mutate: func(d *commander.ResourceDetail) { d.Config.Type = "" }, wantPath: "config.resource_type"},
		{name: "unexpected metadata provider", mutate: func(d *commander.ResourceDetail) { d.Config.Metadata["provider"] = "sentinel-private-value" }, wantPath: "config.metadata.provider", forbidden: "sentinel-private-value"},
	} {
		t.Run(test.name, func(t *testing.T) {
			detail := base
			detail.Config.Metadata = cloneServiceResourceMetadata()
			test.mutate(&detail)
			err := validateServiceResource(detail, "manager-1", "service-1")
			if err == nil || !strings.Contains(err.Error(), test.wantPath) {
				t.Fatalf("validation error = %v, want %s field path", err, test.wantPath)
			}
			if test.forbidden != "" && strings.Contains(err.Error(), test.forbidden) {
				t.Fatalf("validation error exposed configuration value: %v", err)
			}
		})
	}
}

func TestEnsureServiceResourceRejectsConflicts(t *testing.T) {
	valid := commander.ResourceDetail{
		Resource: commander.Resource{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true},
		Config:   commander.ResourceConfig{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", Metadata: map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": float64(1)}},
	}
	tests := []struct {
		name      string
		resources []commander.Resource
		resource  commander.ResourceDetail
	}{
		{name: "wrong metadata", resources: []commander.Resource{valid.Resource}, resource: func() commander.ResourceDetail {
			d := valid
			d.Config.Metadata = map[string]any{"provider": "other"}
			return d
		}()},
		{name: "foreign owner", resources: []commander.Resource{{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "other", External: true}}, resource: valid},
		{name: "duplicate resources", resources: []commander.Resource{valid.Resource, {ID: "service-2", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true}}, resource: valid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cc := &fakeCommander{resources: test.resources, resource: test.resource}
			_, err := NewService("manager-1", cc, nil).EnsureServiceResource(context.Background())
			if err == nil {
				t.Fatal("expected a conflicting resource error")
			}
			if len(cc.createResources) != 0 {
				t.Fatalf("created another resource after conflict: %#v", cc.createResources)
			}
		})
	}
}

func TestEnsureServiceResourcePropagatesCommanderFailure(t *testing.T) {
	for _, test := range []struct {
		name string
		cc   *fakeCommander
	}{
		{name: "list", cc: &fakeCommander{listResourcesErr: errors.New("list failed")}},
		{name: "create", cc: &fakeCommander{resource: commander.ResourceDetail{Resource: commander.Resource{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", External: true}, Config: commander.ResourceConfig{ID: "service-1", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "manager-1", Metadata: map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": float64(1)}}}, createResourceErr: errors.New("create failed")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			id, err := NewService("manager-1", test.cc, nil).EnsureServiceResource(context.Background())
			if err == nil || id != "" {
				t.Fatalf("ID = %q, error = %v; want failure with no ID", id, err)
			}
		})
	}
}

func TestEnsureServiceResourceRejectsInvalidCreatedRecord(t *testing.T) {
	cc := &fakeCommander{resource: commander.ResourceDetail{Resource: commander.Resource{ID: "foreign", Name: ServiceResourceName, Type: ServiceResourceType, Manager: "other", External: true}}}
	id, err := NewService("manager-1", cc, nil).EnsureServiceResource(context.Background())
	if err == nil || id != "" || !strings.Contains(err.Error(), "created resource") {
		t.Fatalf("ID = %q, error = %v; want invalid created resource error", id, err)
	}
}
