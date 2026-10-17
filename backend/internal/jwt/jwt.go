package jwt

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	secretBytes       = 32
	maxTokenBytes     = 32 << 10
	maxLifetime       = 60 * time.Second
	clockSkew         = 5 * time.Second
	acceptedType      = "JWT"
	acceptedAlgorithm = "HS256"
)

type Claims struct {
	Audience  string          `json:"aud"`
	Path      string          `json:"path"`
	Origin    string          `json:"origin"`
	IssuedAt  int64           `json:"iat"`
	ExpiresAt int64           `json:"exp"`
	Data      json.RawMessage `json:"data"`
}

type header struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

// GenerateSecret returns 256 bits from the operating system random source as
// an unpadded base64url string suitable for runner variable capture.
func GenerateSecret() (string, error) {
	secret := make([]byte, secretBytes)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("generate signing secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(secret), nil
}

// Verify validates a compact HS256 JWT for one manager, route, and origin.
func Verify(raw string, key []byte, audience, path, origin string, now time.Time) (Claims, error) {
	var claims Claims
	if len(raw) == 0 || len(raw) > maxTokenBytes {
		return claims, errors.New("invalid request token")
	}
	if len(key) != secretBytes || audience == "" || path == "" || origin == "" {
		return claims, errors.New("invalid request token configuration")
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return claims, errors.New("invalid request token")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, errors.New("invalid request token")
	}
	var parsedHeader header
	if err := decodeStrict(headerBytes, &parsedHeader); err != nil || parsedHeader.Algorithm != acceptedAlgorithm || parsedHeader.Type != acceptedType {
		return claims, errors.New("invalid request token")
	}
	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(claimsBytes) == 0 {
		return claims, errors.New("invalid request token")
	}
	if err := decodeStrict(claimsBytes, &claims); err != nil {
		return Claims{}, errors.New("invalid request token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(signature) != sha256.Size {
		return Claims{}, errors.New("invalid request token")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return Claims{}, errors.New("invalid request token")
	}
	if claims.Audience != audience || claims.Path != path || claims.Origin != origin || len(claims.Data) == 0 || string(claims.Data) == "null" {
		return Claims{}, errors.New("invalid request token")
	}
	issued := time.Unix(claims.IssuedAt, 0)
	expires := time.Unix(claims.ExpiresAt, 0)
	if claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt || expires.Sub(issued) > maxLifetime || issued.After(now.Add(clockSkew)) || expires.Before(now.Add(-clockSkew)) {
		return Claims{}, errors.New("invalid request token")
	}
	return claims, nil
}

func decodeStrict(data []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("unexpected trailing JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
