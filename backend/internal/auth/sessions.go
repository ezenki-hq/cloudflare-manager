package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"
	"time"
)

const SessionHeader = "X-Cloudflare-Session"

const maxSessionLifetime = 30 * time.Minute

const defaultSessionCapacity = 1024

type storedSession struct {
	token     string
	managerID string
	origin    string
	expiresAt time.Time
}

type sessionStore struct {
	mu        sync.Mutex
	managerID string
	now       func() time.Time
	capacity  int
	entries   map[string]storedSession
}

func newSessionStore(managerID string, now func() time.Time, capacity int) *sessionStore {
	if now == nil {
		now = time.Now
	}
	if capacity <= 0 {
		capacity = defaultSessionCapacity
	}
	return &sessionStore{managerID: managerID, now: now, capacity: capacity, entries: make(map[string]storedSession)}
}

func (s *sessionStore) issue(token, origin string, tokenExpiry time.Time) (string, error) {
	now := s.now()
	if token == "" || !validOrigin(origin) || s.managerID == "" || !tokenExpiry.After(now) {
		return "", errors.New("Cloudflare session is invalid")
	}
	expiresAt := tokenExpiry
	if maximum := now.Add(maxSessionLifetime); expiresAt.After(maximum) {
		expiresAt = maximum
	}
	handle, err := randomURLToken(32)
	if err != nil {
		return "", errors.New("Cloudflare session handle could not be created")
	}
	digest := sha256.Sum256([]byte(handle))
	id := hex.EncodeToString(digest[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredLocked(now)
	if len(s.entries) >= s.capacity {
		s.evictEarliestLocked()
	}
	s.entries[id] = storedSession{token: token, managerID: s.managerID, origin: origin, expiresAt: expiresAt}
	return handle, nil
}

func (s *sessionStore) resolve(handle, origin string) (string, bool) {
	if handle == "" || !validOrigin(origin) {
		return "", false
	}
	digest := sha256.Sum256([]byte(handle))
	id := hex.EncodeToString(digest[:])
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, exists := s.entries[id]
	if !exists {
		return "", false
	}
	if !entry.expiresAt.After(now) {
		delete(s.entries, id)
		return "", false
	}
	if entry.managerID != s.managerID || entry.origin != origin {
		return "", false
	}
	return entry.token, true
}

func (s *sessionStore) remove(handle string) {
	if handle == "" {
		return
	}
	digest := sha256.Sum256([]byte(handle))
	s.mu.Lock()
	delete(s.entries, hex.EncodeToString(digest[:]))
	s.mu.Unlock()
}

func (s *sessionStore) pruneExpiredLocked(now time.Time) {
	for id, entry := range s.entries {
		if !entry.expiresAt.After(now) {
			delete(s.entries, id)
		}
	}
}

func (s *sessionStore) evictEarliestLocked() {
	var earliestID string
	var earliest time.Time
	for id, entry := range s.entries {
		if earliestID == "" || entry.expiresAt.Before(earliest) {
			earliestID, earliest = id, entry.expiresAt
		}
	}
	if earliestID != "" {
		delete(s.entries, earliestID)
	}
}

func (h *Handler) ClearHandle(r *http.Request) {
	if h.sessions != nil {
		h.sessions.remove(r.Header.Get(SessionHeader))
	}
}
