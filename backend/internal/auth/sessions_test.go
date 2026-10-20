package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSessionHandleBindsTokenToManagerOriginAndExpiry(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	current := now
	store := newSessionStore("manager-a", func() time.Time { return current }, 1024)
	handle, err := store.issue("private-cloudflare-token", "https://frontend.example", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://manager.example/api/session", nil)
	request.Header.Set("Origin", "https://frontend.example")
	request.Header.Set(SessionHeader, handle)
	if token, ok := store.resolve(handle, request.Header.Get("Origin")); !ok || token != "private-cloudflare-token" {
		t.Fatalf("resolve() = (%q, %t), want saved token", token, ok)
	}
	if _, ok := store.resolve(handle, "https://other.example"); ok {
		t.Fatal("session handle was accepted from another frontend origin")
	}
	if _, ok := newSessionStore("manager-b", func() time.Time { return current }, 1024).resolve(handle, "https://frontend.example"); ok {
		t.Fatal("session handle was accepted by another manager")
	}
	current = now.Add(30*time.Minute + time.Second)
	if _, ok := store.resolve(handle, "https://frontend.example"); ok {
		t.Fatal("session handle outlived its 30-minute maximum")
	}
}

func TestSessionHandleExpiresWithShorterCloudflareTokenLifetime(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	current := now
	store := newSessionStore("manager-a", func() time.Time { return current }, 10)
	handle, err := store.issue("private-token", "https://frontend.example", now.Add(5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	current = now.Add(5 * time.Minute)
	if _, ok := store.resolve(handle, "https://frontend.example"); ok {
		t.Fatal("session handle outlived Cloudflare token expiry")
	}
}

func TestSessionStoreEvictsEarliestExpiryAndRestartClearsHandles(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	store := newSessionStore("manager-a", func() time.Time { return now }, 2)
	first, err := store.issue("token-1", "https://frontend.example", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.issue("token-2", "https://frontend.example", now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	third, err := store.issue("token-3", "https://frontend.example", now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.resolve(first, "https://frontend.example"); ok {
		t.Fatal("earliest-expiring handle was not evicted at capacity")
	}
	if _, ok := store.resolve(second, "https://frontend.example"); !ok {
		t.Fatal("second handle was evicted")
	}
	if _, ok := store.resolve(third, "https://frontend.example"); !ok {
		t.Fatal("new handle was not retained")
	}
	if _, ok := newSessionStore("manager-a", func() time.Time { return now }, 2).resolve(second, "https://frontend.example"); ok {
		t.Fatal("handle survived a backend restart")
	}
}

func TestHandlerRejectsInvalidHandleInsteadOfUsingCookie(t *testing.T) {
	h := &Handler{sessions: newSessionStore("manager-a", time.Now, 1024)}
	request := httptest.NewRequest(http.MethodPost, "https://manager.example/api/session", nil)
	request.Header.Set("Origin", "https://frontend.example")
	request.Header.Set(SessionHeader, "invalid-handle")
	request.AddCookie(&http.Cookie{Name: accessCookieName, Value: "cookie-token"})
	if token, ok := h.Token(request); ok || token != "" {
		t.Fatalf("invalid handle silently used cookie token %q", token)
	}
}

func TestHandlerUsesCookieWhenNoSessionHandleIsProvided(t *testing.T) {
	h := &Handler{sessions: newSessionStore("manager-a", time.Now, 1024)}
	request := httptest.NewRequest(http.MethodPost, "https://manager.example/api/session", nil)
	request.AddCookie(&http.Cookie{Name: accessCookieName, Value: "cookie-token"})
	if token, ok := h.Token(request); !ok || token != "cookie-token" {
		t.Fatalf("cookie fallback = (%q, %t)", token, ok)
	}
}

func TestSessionHandleIsNotTheCloudflareToken(t *testing.T) {
	store := newSessionStore("manager-a", time.Now, 1024)
	handle, err := store.issue("very-secret-cloudflare-token", "https://frontend.example", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if handle == "very-secret-cloudflare-token" || strings.Contains(handle, "very-secret-cloudflare-token") {
		t.Fatalf("session handle exposes the Cloudflare token: %q", handle)
	}
	for key, value := range store.entries {
		if strings.Contains(key, handle) || strings.Contains(key, "very-secret-cloudflare-token") || value.token != "very-secret-cloudflare-token" {
			t.Fatalf("unexpected in-memory session record: key=%q value=%#v", key, value)
		}
	}
}
