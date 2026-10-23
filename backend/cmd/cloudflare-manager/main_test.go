package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

func TestGenerateJWTSecretCommandPrintsOnlySecret(t *testing.T) {
	var output bytes.Buffer
	if err := runCommand([]string{"generate-jwt-secret"}, &output); err != nil {
		t.Fatal(err)
	}
	secret := strings.TrimSuffix(output.String(), "\n")
	if strings.Contains(secret, "\n") || len(secret) != 43 {
		t.Fatalf("command output must contain one 43-character secret line, got %q", output.String())
	}
	decoded, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("command output is not a 32-byte base64url secret: %v", err)
	}
}

func TestPrepareCommanderStopsBeforeHealthOnResourceFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/manager":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "manager-1"})
		case "/api/v1/resources/mine":
			if r.URL.Query().Get("type") != "s3" {
				t.Errorf("resource query type = %q, want s3", r.URL.Query().Get("type"))
			}
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		default:
			t.Errorf("unexpected Commander request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := commander.NewClient(server.URL+"/api/v1", "manager-1", "password", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	err = prepareCommander(t.Context(), "manager-1", client)
	if err == nil || !strings.Contains(err.Error(), "ensure S3 service resource") {
		t.Fatalf("prepareCommander error = %v, want resource ensure failure", err)
	}
}

func TestPrepareCommanderLogsSafeStartupStagesOnFailure(t *testing.T) {
	const managerPassword = "sentinel-manager-password"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/manager":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "manager-1"})
		case "/api/v1/resources/mine":
			http.Error(w, managerPassword, http.StatusServiceUnavailable)
		default:
			t.Errorf("unexpected Commander request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := commander.NewClient(server.URL+"/api/v1", "manager-1", managerPassword, server.Client())
	if err != nil {
		t.Fatal(err)
	}

	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	err = prepareCommander(t.Context(), "manager-1", client)
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("prepareCommander error = %v, want status 503", err)
	}
	for _, stage := range []string{"commander_verified", "s3_provisioner_lookup_started"} {
		if !strings.Contains(logs.String(), `stage=`+stage) {
			t.Errorf("logs missing stage %q: %s", stage, logs.String())
		}
	}
	for _, sensitive := range []string{managerPassword, server.URL} {
		if strings.Contains(logs.String(), sensitive) {
			t.Errorf("logs contain sensitive or endpoint value %q: %s", sensitive, logs.String())
		}
	}
}

func TestPrepareCommanderAcceptsCommanderResourceTypeInConfig(t *testing.T) {
	resourceCreated := false
	createCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/manager":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "manager-1"})
		case "/api/v1/resources/mine":
			items := []any{}
			if resourceCreated {
				items = append(items, map[string]any{"id": "service-1", "name": "Cloudflare R2 S3", "type": "s3", "manager": "manager-1", "external": true})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "limit": 100, "offset": 0, "total": len(items)})
		case "/api/v1/resources/service-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"resource": map[string]any{"id": "service-1", "name": "Cloudflare R2 S3", "type": "s3", "manager": "manager-1", "external": true},
				"config": map[string]any{
					"id": "service-1", "name": "Cloudflare R2 S3", "resource_type": "s3", "manager": "manager-1",
					"metadata": map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1},
				},
			})
		case "/api/v1/resources":
			if r.Method != http.MethodPost {
				t.Errorf("resource request method = %q, want POST", r.Method)
			}
			resourceCreated = true
			createCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"resource": map[string]any{"id": "service-1", "name": "Cloudflare R2 S3", "type": "s3", "manager": "manager-1", "external": true},
				"config": map[string]any{
					"id": "service-1", "name": "Cloudflare R2 S3", "resource_type": "s3", "manager": "manager-1",
					"metadata": map[string]any{"provider": "cloudflare-r2", "role": "provisioner", "contract_version": 1},
				},
			})
		default:
			t.Errorf("unexpected Commander request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := commander.NewClient(server.URL+"/api/v1", "manager-1", "password", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	if err := prepareCommander(t.Context(), "manager-1", client); err != nil {
		t.Fatalf("prepareCommander rejected Commander resource_type response: %v", err)
	}
	if err := prepareCommander(t.Context(), "manager-1", client); err != nil {
		t.Fatalf("prepareCommander rejected existing Commander resource_type response: %v", err)
	}
	if createCalls != 1 {
		t.Fatalf("created the provisioner %d times, want once across install and reinstall", createCalls)
	}
}
