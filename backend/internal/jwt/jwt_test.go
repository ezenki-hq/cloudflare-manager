package jwt

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

func TestGenerateSecretReturns32BytesAsUnpaddedBase64URL(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(secret) != 43 || strings.Contains(secret, "=") {
		t.Fatalf("secret must be 43 unpadded base64url characters, got %q", secret)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil {
		t.Fatalf("secret is not base64url: %v", err)
	}
	if len(decoded) != 32 {
		t.Fatalf("secret contains %d bytes, want 32", len(decoded))
	}
}

func TestGenerateSecretUsesFreshRandomBytes(t *testing.T) {
	first, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("consecutive generated secrets were identical")
	}
}

func TestVerifyAcceptsValidManagerJWT(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw := signJWT(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT"}, map[string]any{
		"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": map[string]any{},
	})

	claims, err := Verify(raw, testKey, "manager-1", "/api/accounts/list", "https://manager.example", now)
	if err != nil {
		t.Fatalf("Verify rejected valid token: %v", err)
	}
	if claims.Audience != "manager-1" || claims.Path != "/api/accounts/list" || claims.Origin != "https://manager.example" {
		t.Fatalf("claims not decoded: %+v", claims)
	}
	if string(claims.Data) != `{}` {
		t.Fatalf("data = %s, want {}", claims.Data)
	}
}

func TestVerifyRejectsInvalidManagerJWT(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	validClaims := func() map[string]any {
		return map[string]any{
			"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
			"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": map[string]any{},
		}
	}
	validHeader := map[string]any{"alg": "HS256", "typ": "JWT"}

	tests := []struct {
		name  string
		token string
	}{
		{name: "bad signature", token: tamperSignature(signJWT(t, testKey, validHeader, validClaims()))},
		{name: "none algorithm", token: signJWT(t, testKey, map[string]any{"alg": "none", "typ": "JWT"}, validClaims())},
		{name: "unexpected header field", token: signJWT(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT", "kid": "other"}, validClaims())},
		{name: "wrong audience", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "aud", "other"))},
		{name: "wrong path", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "path", "/api/other"))},
		{name: "wrong origin", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "origin", "https://other.example"))},
		{name: "future issue time", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "iat", now.Add(6*time.Second).Unix()))},
		{name: "expired", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "exp", now.Add(-6*time.Second).Unix()))},
		{name: "lifetime exceeds sixty seconds", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "exp", now.Add(61*time.Second).Unix()))},
		{name: "non-increasing lifetime", token: signJWT(t, testKey, validHeader, claimsWith(validClaims(), "exp", now.Unix()))},
		{name: "malformed compact token", token: "a.b"},
		{name: "malformed base64", token: "!.e30.signature"},
		{name: "malformed header JSON", token: base64.RawURLEncoding.EncodeToString([]byte("{")) + ".e30.signature"},
		{name: "malformed claims JSON", token: encodeJSON(map[string]any{"alg": "HS256", "typ": "JWT"}) + "." + base64.RawURLEncoding.EncodeToString([]byte("{")) + ".signature"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			claims, err := Verify(test.token, testKey, "manager-1", "/api/accounts/list", "https://manager.example", now)
			if err == nil {
				t.Fatalf("Verify accepted invalid token and returned %+v", claims)
			}
			if len(claims.Data) != 0 {
				t.Fatalf("invalid token returned data %s", claims.Data)
			}
		})
	}
}

func TestVerifyRejectsTokenLargerThan32KiB(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	data := map[string]any{
		"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": strings.Repeat("x", 33<<10),
	}
	raw := signJWT(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT"}, data)
	if len(raw) <= 32<<10 {
		t.Fatalf("fixture is only %d bytes", len(raw))
	}
	if _, err := Verify(raw, testKey, "manager-1", "/api/accounts/list", "https://manager.example", now); err == nil {
		t.Fatal("Verify accepted token larger than 32 KiB")
	}
}

func TestVerifyRejectsWeakVerificationKey(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw := signJWT(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT"}, map[string]any{
		"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": map[string]any{},
	})
	if _, err := Verify(raw, testKey[:16], "manager-1", "/api/accounts/list", "https://manager.example", now); err == nil {
		t.Fatal("Verify accepted a key shorter than 32 bytes")
	}
}

func TestVerifyRejectsTrailingClaimsJSON(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	claims := map[string]any{
		"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": map[string]any{},
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	claimsJSON = append(claimsJSON, []byte(" {}")...)
	raw := signRawClaims(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT"}, claimsJSON)
	if _, err := Verify(raw, testKey, "manager-1", "/api/accounts/list", "https://manager.example", now); err == nil {
		t.Fatal("Verify accepted trailing claims JSON")
	}
}

func TestVerifyRejectsMalformedTrailingClaimsBytes(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	claims := map[string]any{
		"aud": "manager-1", "path": "/api/accounts/list", "origin": "https://manager.example",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "data": map[string]any{},
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	claimsJSON = append(claimsJSON, []byte(" x")...)
	raw := signRawClaims(t, testKey, map[string]any{"alg": "HS256", "typ": "JWT"}, claimsJSON)
	if _, err := Verify(raw, testKey, "manager-1", "/api/accounts/list", "https://manager.example", now); err == nil {
		t.Fatal("Verify accepted malformed trailing claims bytes")
	}
}

func signJWT(t *testing.T, key []byte, header, claims map[string]any) string {
	t.Helper()
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return signRawClaims(t, key, header, claimsJSON)
}

func signRawClaims(t *testing.T, key []byte, header map[string]any, claimsJSON []byte) string {
	t.Helper()
	unsigned := encodeJSON(header) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func encodeJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func claimsWith(claims map[string]any, key string, value any) map[string]any {
	copy := make(map[string]any, len(claims))
	for name, current := range claims {
		copy[name] = current
	}
	copy[key] = value
	return copy
}

func tamperSignature(token string) string {
	parts := strings.Split(token, ".")
	decoded, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		panic(err)
	}
	decoded[0] ^= 0xff
	parts[2] = base64.RawURLEncoding.EncodeToString(decoded)
	return strings.Join(parts, ".")
}
