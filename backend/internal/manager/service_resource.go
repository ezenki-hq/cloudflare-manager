package manager

import (
	"context"
	"errors"
	"fmt"

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
		detail, err := s.commander.GetResource(ctx, resource.ID)
		if err != nil {
			return "", fmt.Errorf("read S3 service resource: %w", err)
		}
		if err := validateServiceResource(detail, s.managerID, resource.ID); err != nil {
			return "", err
		}
		return detail.Resource.ID, nil
	}

	detail, err := s.commander.CreateResource(ctx, commander.ResourceCreate{
		Name: ServiceResourceName, Type: ServiceResourceType, External: true,
		Metadata: cloneServiceResourceMetadata(),
	})
	if err != nil {
		return "", fmt.Errorf("create S3 service resource: %w", err)
	}
	if err := validateServiceResource(detail, s.managerID, detail.Resource.ID); err != nil {
		return "", fmt.Errorf("created resource could not be verified: %w", err)
	}
	return detail.Resource.ID, nil
}

func validateServiceResource(detail commander.ResourceDetail, managerID, resourceID string) error {
	resource := detail.Resource
	config := detail.Config
	if resourceID == "" || resource.ID != resourceID || resource.Manager != managerID || resource.Type != ServiceResourceType || resource.Name != ServiceResourceName || !resource.External {
		return errors.New("S3 resource is not the expected Cloudflare R2 provisioner")
	}
	if config.ID != resourceID || config.Manager != managerID || config.Type != ServiceResourceType || config.Name != ServiceResourceName || !metadataMatchesServiceResource(config.Metadata) {
		return errors.New("S3 resource configuration does not match the Cloudflare R2 provisioner")
	}
	return nil
}

func metadataMatchesServiceResource(metadata map[string]any) bool {
	if len(metadata) != len(serviceResourceMetadata) || metadata["provider"] != "cloudflare-r2" || metadata["role"] != "provisioner" {
		return false
	}
	switch version := metadata["contract_version"].(type) {
	case int:
		return version == 1
	case int64:
		return version == 1
	case float64:
		return version == 1
	default:
		return false
	}
}

func cloneServiceResourceMetadata() map[string]any {
	metadata := make(map[string]any, len(serviceResourceMetadata))
	for key, value := range serviceResourceMetadata {
		metadata[key] = value
	}
	return metadata
}
