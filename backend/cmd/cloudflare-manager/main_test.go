package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
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
