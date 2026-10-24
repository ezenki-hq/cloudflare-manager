package manager

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

const (
	ServiceResourceType = "s3"
	ServiceResourceName = "Cloudflare R2 S3"
)

var serviceResourceMetadata = map[string]any{
	"provider":         "cloudflare-r2",
	"role":             "provisioner",
	"contract_version": 1,
}

// EnsureServiceResource publishes the stable S3 provisioning entry point.
func (s *Service) EnsureServiceResource(ctx context.Context) (string, error) {
	slog.Info("Cloudflare Manager startup", "stage", "s3_provisioner_lookup_started")
	resources, err := s.commander.ListMyResources(ctx, ServiceResourceType)
	if err != nil {
		return "", fmt.Errorf("list S3 service resources: %w", err)
	}
	if len(resources) > 1 {
		return "", errors.New("multiple S3 service resources exist for this manager")
	}
	if len(resources) == 1 {
		resource := resources[0]
		if resource.Manager != s.managerID || resource.Type != ServiceResourceType || resource.Name != ServiceResourceName || !resource.External {
			return "", errors.New("existing S3 resource conflicts with the Cloudflare R2 provisioner")
		}
		slog.Info("Cloudflare Manager startup", "stage", "s3_provisioner_reuse_started")
		detail, err := s.commander.GetResource(ctx, resource.ID)
		if err != nil {
			return "", fmt.Errorf("read S3 service resource: %w", err)
		}
		if err := validateServiceResource(detail, s.managerID, resource.ID); err != nil {
			return "", err
		}
		slog.Info("Cloudflare Manager startup", "stage", "s3_provisioner_reused")
		return detail.Resource.ID, nil
	}

	slog.Info("Cloudflare Manager startup", "stage", "s3_provisioner_create_started")
	detail, err := s.commander.CreateResource(ctx, commander.ResourceCreate{
		Name: ServiceResourceName, Type: ServiceResourceType, External: true,
		Metadata: cloneServiceResourceMetadata(),
	})
	if err != nil {
		var apiErr *commander.APIError
		if errors.As(err, &apiErr) {
			validationStatus, locations, kinds := apiErr.ValidationDiagnostics()
			slog.Error("Cloudflare Manager startup",
				"stage", "s3_provisioner_create_rejected",
				"status", apiErr.StatusCode,
				"validation_status", validationStatus,
				"validation_locations", locations,
				"validation_categories", kinds,
			)
		} else {
			slog.Error("Cloudflare Manager startup", "stage", "s3_provisioner_create_rejected", "error_kind", "commander_request_failed")
		}
		return "", fmt.Errorf("create S3 service resource: %w", err)
	}
	if err := validateServiceResource(detail, s.managerID, detail.Resource.ID); err != nil {
		return "", fmt.Errorf("created resource could not be verified: %w", err)
	}
	slog.Info("Cloudflare Manager startup", "stage", "s3_provisioner_created")
	return detail.Resource.ID, nil
}

func validateServiceResource(detail commander.ResourceDetail, managerID, resourceID string) error {
	resource := detail.Resource
	config := detail.Config
	for _, check := range []struct {
		path string
		ok   bool
	}{
		{"resource.id", resourceID != "" && resource.ID == resourceID},
		{"resource.manager", resource.Manager == managerID},
		{"resource.type", resource.Type == ServiceResourceType},
		{"resource.name", resource.Name == ServiceResourceName},
		{"resource.external", resource.External},
		{"config.id", config.ID == resourceID},
		{"config.manager", config.Manager == managerID},
		{"config.resource_type", config.Type == ServiceResourceType},
		{"config.name", config.Name == ServiceResourceName},
	} {
		if !check.ok {
			return fmt.Errorf("S3 resource does not match the Cloudflare R2 provisioner at %s", check.path)
		}
	}
	if path := serviceResourceMetadataMismatch(config.Metadata); path != "" {
		return fmt.Errorf("S3 resource does not match the Cloudflare R2 provisioner at %s", path)
	}
	return nil
}

func serviceResourceMetadataMismatch(metadata map[string]any) string {
	if len(metadata) != len(serviceResourceMetadata) {
		return "config.metadata"
	}
	if metadata["provider"] != serviceResourceMetadata["provider"] {
		return "config.metadata.provider"
	}
	if metadata["role"] != serviceResourceMetadata["role"] {
		return "config.metadata.role"
	}
	switch version := metadata["contract_version"].(type) {
	case int:
		if version == 1 {
			return ""
		}
	case int64:
		if version == 1 {
			return ""
		}
	case float64:
		if version == 1 {
			return ""
		}
	}
	return "config.metadata.contract_version"
}

func cloneServiceResourceMetadata() map[string]any {
	metadata := make(map[string]any, len(serviceResourceMetadata))
	for key, value := range serviceResourceMetadata {
		metadata[key] = value
	}
	return metadata
}
