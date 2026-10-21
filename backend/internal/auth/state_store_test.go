package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

type pendingDB struct {
	mu      sync.Mutex
	records map[string]pendingRecord
	err     error
	queries []string
	args    []map[string]any
}

func newPendingDB() *pendingDB { return &pendingDB{records: make(map[string]pendingRecord)} }

func (db *pendingDB) DatabaseQuery(_ context.Context, query string, bindings map[string]any) ([]commander.QueryResult, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.queries = append(db.queries, query)
	db.args = append(db.args, bindings)
	if db.err != nil {
		return nil, db.err
	}
	var result any
	switch {
	case strings.Contains(query, "CREATE oauth_pending_state:[$id]"):
		id := bindings["id"].(string)
		if _, exists := db.records[id]; exists {
			return nil, errors.New("duplicate record")
		}
		db.records[id] = pendingRecord{ExpiresAt: bindings["expires_at"].(int64), Payload: bindings["payload"].(string)}
		result = []pendingRecord{db.records[id]}
	case strings.Contains(query, "DELETE oauth_pending_state:[$id]"):
		id, now := bindings["id"].(string), bindings["now"].(int64)
		if row, ok := db.records[id]; ok && row.ExpiresAt > now {
			delete(db.records, id)
			result = []pendingRecord{row}
		} else {
			result = []pendingRecord{}
		}
	case strings.Contains(query, "DELETE oauth_pending_state WHERE expires_at <= $now"):
		now := bindings["now"].(int64)
		removed := make([]pendingRecord, 0)
		for id, row := range db.records {
			if row.ExpiresAt <= now {
				removed = append(removed, row)
				delete(db.records, id)
			}
		}
		result = removed
	default:
		return nil, errors.New("unexpected query")
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return []commander.QueryResult{{Statement: 0, Status: "OK", Result: encoded}}, nil
}

func TestPendingStoreAllowsOnlyOneConcurrentConsume(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	db := newPendingDB()
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	state := PendingState{Verifier: "pkce", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: now.Add(time.Minute).Unix()}
	if err := store.Put(context.Background(), "concurrent-state", state); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		ok  bool
		err error
	}
	results := make(chan outcome, 2)
	for range 2 {
		go func() {
			_, err := store.Take(context.Background(), "concurrent-state", now)
			results <- outcome{ok: err == nil, err: err}
		}()
	}
	successes := 0
	for range 2 {
		if result := <-results; result.ok {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent consume successes = %d, want exactly one", successes)
	}
}

func TestPendingStorePersistsOnlyHashedAndEncryptedState(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	db := newPendingDB()
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	wantID := sha256.Sum256([]byte("opaque-state-value"))
	state := PendingState{Verifier: "pkce-verifier-value", OpenerOrigin: "http://commander.local", ClientID: "client-1", RedirectURI: "http://manager.local/auth/callback", ManagerID: "manager-a", ExpiresAt: now.Add(10 * time.Minute).Unix()}
	if err := store.Put(context.Background(), "opaque-state-value", state); err != nil {
		t.Fatal(err)
	}
	row, ok := db.records[hex.EncodeToString(wantID[:])]
	if !ok || row.ExpiresAt != state.ExpiresAt {
		t.Fatalf("stored row = %#v, exists=%t", row, ok)
	}
	if strings.Contains(row.Payload, "opaque-state-value") || strings.Contains(row.Payload, "pkce-verifier-value") || strings.Contains(db.queries[0], "opaque-state-value") {
		t.Fatalf("raw OAuth state was persisted: row=%#v query=%q", row, db.queries[0])
	}
	if !strings.Contains(db.queries[0], "CREATE oauth_pending_state:[$id]") || db.args[0]["id"] != hex.EncodeToString(wantID[:]) {
		t.Fatalf("state query or key binding = %q %#v", db.queries[0], db.args[0])
	}
	if err := store.Put(context.Background(), "another-state", PendingState{ExpiresAt: now.Unix()}); err == nil {
		t.Fatal("expired state was stored")
	}
}

func TestPendingStoreSurvivesRestartAndConsumesOnce(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	db := newPendingDB()
	first, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	want := PendingState{Verifier: "pkce", OpenerOrigin: "https://front.example", ClientID: "client-1", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: now.Add(10 * time.Minute).Unix()}
	if err := first.Put(context.Background(), "one-time-state", want); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	got, err := restarted.Take(context.Background(), "one-time-state", now)
	if err != nil || got != want {
		t.Fatalf("Take() = %#v, %v; want %#v", got, err, want)
	}
	if _, err := restarted.Take(context.Background(), "one-time-state", now); err == nil {
		t.Fatal("replayed state was accepted")
	}
	if !strings.Contains(db.queries[len(db.queries)-1], "DELETE oauth_pending_state:[$id]") || !strings.Contains(db.queries[len(db.queries)-1], "RETURN BEFORE") {
		t.Fatalf("consume was not a single delete-return query: %q", db.queries[len(db.queries)-1])
	}
}

func TestPendingStoreRejectsExpiredOrTamperedPayload(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for _, name := range []string{"expired", "tampered", "wrong password", "wrong manager"} {
		t.Run(name, func(t *testing.T) {
			db := newPendingDB()
			store, err := NewPendingStore(db, "manager-a", "commander-password")
			if err != nil {
				t.Fatal(err)
			}
			state := PendingState{Verifier: "pkce", OpenerOrigin: "https://front.example", ClientID: "client-1", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: now.Add(time.Minute).Unix()}
			if err := store.Put(context.Background(), "state-"+name, state); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "expired":
				if _, err := store.Take(context.Background(), "state-"+name, now.Add(2*time.Minute)); err == nil {
					t.Fatal("expired state was accepted")
				}
				return
			case "tampered":
				id := stateRecordID("state-" + name)
				row := db.records[id]
				ciphertext, err := base64.RawURLEncoding.DecodeString(row.Payload)
				if err != nil {
					t.Fatal(err)
				}
				ciphertext[len(ciphertext)-1] ^= 1
				row.Payload = base64.RawURLEncoding.EncodeToString(ciphertext)
				db.records[id] = row
			case "wrong password":
				store, err = NewPendingStore(db, "manager-a", "different-password")
			case "wrong manager":
				store, err = NewPendingStore(db, "manager-b", "commander-password")
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.Take(context.Background(), "state-"+name, now); err == nil {
				t.Fatal("invalid pending state was accepted")
			}
		})
	}
}

func TestPendingStorePrunesOnlyExpiredRecords(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	db := newPendingDB()
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	for id, expiry := range map[string]int64{"old-a": now.Add(2 * time.Minute).Unix(), "old-b": now.Add(3 * time.Minute).Unix(), "live": now.Add(5 * time.Minute).Unix()} {
		if err := store.Put(context.Background(), id, PendingState{Verifier: "v", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: expiry}); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := store.Prune(context.Background(), now.Add(4*time.Minute))
	if err != nil || removed != 2 {
		t.Fatalf("Prune() = %d, %v; want 2, nil", removed, err)
	}
	if len(db.records) != 1 || db.records[stateRecordID("live")].ExpiresAt != now.Add(5*time.Minute).Unix() {
		t.Fatalf("records after prune = %#v", db.records)
	}
	if !strings.Contains(db.queries[len(db.queries)-1], "DELETE oauth_pending_state WHERE expires_at <= $now RETURN BEFORE") {
		t.Fatalf("prune query = %q", db.queries[len(db.queries)-1])
	}
}

func TestPendingStorePropagatesDatabaseErrors(t *testing.T) {
	db := newPendingDB()
	db.err = errors.New("Commander service is unavailable")
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	state := PendingState{Verifier: "v", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	if err := store.Put(context.Background(), "state", state); err == nil {
		t.Fatal("database failure was ignored")
	}
	if _, err := store.Prune(context.Background(), time.Now()); err == nil {
		t.Fatal("database failure was ignored")
	}
}

func TestPendingStoreDistinguishesRejectedQueryFromUnavailableCommander(t *testing.T) {
	db := newPendingDB()
	db.err = &commander.DatabaseQueryError{Kind: commander.DatabaseQueryStatementFailed, Statement: 0}
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	state := PendingState{Verifier: "v", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	err = store.Put(context.Background(), "state", state)
	if !errors.Is(err, ErrStateStoreRejected) || errors.Is(err, ErrStateStoreUnavailable) {
		t.Fatalf("Put() error = %v; want Commander query rejection only", err)
	}
}

func TestPendingStoreDistinguishesInvalidDatabaseResponse(t *testing.T) {
	db := newPendingDB()
	db.err = &commander.DatabaseQueryError{Kind: commander.DatabaseQueryResultInvalid, Statement: 0}
	store, err := NewPendingStore(db, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	state := PendingState{Verifier: "v", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	err = store.Put(context.Background(), "state", state)
	if !errors.Is(err, ErrStateStoreInvalidResponse) || errors.Is(err, ErrStateStoreRejected) || errors.Is(err, ErrStateStoreUnavailable) {
		t.Fatalf("Put() error = %v; want invalid Commander response only", err)
	}
}

type invalidCleanupResultDB struct{}

func (invalidCleanupResultDB) DatabaseQuery(context.Context, string, map[string]any) ([]commander.QueryResult, error) {
	return []commander.QueryResult{{Statement: 0, Status: "OK", Result: json.RawMessage(`null`)}}, nil
}

type fixedQueryResultDB struct{ result json.RawMessage }

func (db fixedQueryResultDB) DatabaseQuery(context.Context, string, map[string]any) ([]commander.QueryResult, error) {
	return []commander.QueryResult{{Statement: 0, Status: "OK", Result: db.result}}, nil
}

func TestPendingStoreRejectsUnconfirmedCreateResults(t *testing.T) {
	for _, result := range []string{"null", "[]", "[{}]"} {
		t.Run(result, func(t *testing.T) {
			store, err := NewPendingStore(fixedQueryResultDB{result: json.RawMessage(result)}, "manager-a", "commander-password")
			if err != nil {
				t.Fatal(err)
			}
			state := PendingState{Verifier: "v", OpenerOrigin: "https://front.example", ClientID: "client", RedirectURI: "https://manager.example/auth/callback", ManagerID: "manager-a", ExpiresAt: time.Now().Add(time.Minute).Unix()}
			if err := store.Put(context.Background(), "state", state); err == nil {
				t.Fatal("unconfirmed create result was accepted")
			} else if !errors.Is(err, ErrStateStoreInvalidResponse) {
				t.Fatalf("Put() error = %v; want invalid response classification", err)
			}
		})
	}
}

func TestPendingStoreRejectsNonArrayConsumeResultsAsInvalidResponse(t *testing.T) {
	for _, result := range []string{"null", "{}", `"unexpected"`} {
		t.Run(result, func(t *testing.T) {
			store, err := NewPendingStore(fixedQueryResultDB{result: json.RawMessage(result)}, "manager-a", "commander-password")
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.Take(context.Background(), "state", time.Now())
			if !errors.Is(err, ErrStateStoreInvalidResponse) {
				t.Fatalf("Take() error = %v; want invalid response classification", err)
			}
		})
	}
}

func TestPendingStoreRejectsInvalidPruneResultShape(t *testing.T) {
	store, err := NewPendingStore(invalidCleanupResultDB{}, "manager-a", "commander-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Prune(context.Background(), time.Now()); err == nil {
		t.Fatal("null cleanup result was treated as an empty array")
	}
}
