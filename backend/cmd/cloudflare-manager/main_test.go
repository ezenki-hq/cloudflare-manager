package main

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
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
