package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ezenki-hq/cloudflare-manager/backend/internal/commander"
)

const pendingStateTable = "oauth_pending_state"

const pendingStateKeyDomain = "cloudflare-manager/oauth-pending-state/v1"

type PendingState struct {
	Verifier     string `json:"verifier"`
	OpenerOrigin string `json:"opener_origin"`
	ClientID     string `json:"client_id"`
	RedirectURI  string `json:"redirect_uri"`
	ManagerID    string `json:"manager_id"`
	ExpiresAt    int64  `json:"expires_at"`
}

type StateStore interface {
	Put(ctx context.Context, rawState string, value PendingState) error
	Take(ctx context.Context, rawState string, now time.Time) (PendingState, error)
	Prune(ctx context.Context, now time.Time) (int, error)
}

type DatabaseQuerier interface {
	DatabaseQuery(ctx context.Context, query string, bindings map[string]any) ([]commander.QueryResult, error)
}

type PendingStore struct {
	db        DatabaseQuerier
	managerID string
	cipher    cipher.AEAD
}

type pendingRecord struct {
	ExpiresAt int64  `json:"expires_at"`
	Payload   string `json:"payload"`
}

func NewPendingStore(db DatabaseQuerier, managerID, managerPassword string) (*PendingStore, error) {
	managerID = strings.TrimSpace(managerID)
	if db == nil || managerID == "" || managerPassword == "" {
		return nil, errors.New("pending OAuth state store requires Commander database and manager credentials")
	}
	mac := hmac.New(sha256.New, []byte(managerPassword))
	_, _ = mac.Write([]byte(pendingStateKeyDomain))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, errors.New("pending OAuth state encryption could not be configured")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("pending OAuth state encryption could not be configured")
	}
	return &PendingStore{db: db, managerID: managerID, cipher: aead}, nil
}

func (s *PendingStore) Put(ctx context.Context, rawState string, value PendingState) error {
	if rawState == "" || len(rawState) > 256 || value.Verifier == "" || value.ClientID == "" || !validOrigin(value.OpenerOrigin) || !validRedirect(value.RedirectURI) || value.ManagerID != s.managerID || value.ExpiresAt <= time.Now().Unix() {
		return errors.New("pending OAuth state is invalid")
	}
	id := stateRecordID(rawState)
	plaintext, err := json.Marshal(value)
	if err != nil {
		return errors.New("pending OAuth state could not be encoded")
	}
	nonce := make([]byte, s.cipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return errors.New("pending OAuth state encryption failed")
	}
	ciphertext := s.cipher.Seal(nil, nonce, plaintext, s.associatedData(id))
	encoded := base64.RawURLEncoding.EncodeToString(append(nonce, ciphertext...))
	query := "CREATE type::thing('oauth_pending_state', $id) SET expires_at = $expires_at, payload = $payload RETURN AFTER"
	results, err := s.db.DatabaseQuery(ctx, query, map[string]any{"id": id, "expires_at": value.ExpiresAt, "payload": encoded})
	if err != nil {
		return err
	}
	if len(results) != 1 {
		return errors.New("Commander did not confirm pending OAuth state creation")
	}
	return nil
}

func (s *PendingStore) Take(ctx context.Context, rawState string, now time.Time) (PendingState, error) {
	if rawState == "" || len(rawState) > 256 {
		return PendingState{}, errors.New("pending OAuth state is invalid or expired")
	}
	id := stateRecordID(rawState)
	query := "DELETE type::thing('oauth_pending_state', $id) WHERE expires_at > $now RETURN BEFORE"
	results, err := s.db.DatabaseQuery(ctx, query, map[string]any{"id": id, "now": now.Unix()})
	if err != nil {
		return PendingState{}, err
	}
	if len(results) != 1 {
		return PendingState{}, errors.New("pending OAuth state is invalid, expired, or already used")
	}
	var records []pendingRecord
	if err := json.Unmarshal(results[0].Result, &records); err != nil || len(records) != 1 || records[0].ExpiresAt <= now.Unix() {
		return PendingState{}, errors.New("pending OAuth state is invalid, expired, or already used")
	}
	encoded, err := base64.RawURLEncoding.DecodeString(records[0].Payload)
	if err != nil || len(encoded) < s.cipher.NonceSize() {
		return PendingState{}, errors.New("pending OAuth state could not be decrypted")
	}
	nonce, ciphertext := encoded[:s.cipher.NonceSize()], encoded[s.cipher.NonceSize():]
	plaintext, err := s.cipher.Open(nil, nonce, ciphertext, s.associatedData(id))
	if err != nil {
		return PendingState{}, errors.New("pending OAuth state could not be decrypted")
	}
	var value PendingState
	if err := json.Unmarshal(plaintext, &value); err != nil || value.ManagerID != s.managerID || value.ExpiresAt != records[0].ExpiresAt || value.ExpiresAt <= now.Unix() || value.Verifier == "" || value.ClientID == "" || !validOrigin(value.OpenerOrigin) || !validRedirect(value.RedirectURI) {
		return PendingState{}, errors.New("pending OAuth state payload is invalid")
	}
	return value, nil
}

func (s *PendingStore) Prune(ctx context.Context, now time.Time) (int, error) {
	query := "DELETE oauth_pending_state WHERE expires_at <= $now RETURN BEFORE"
	results, err := s.db.DatabaseQuery(ctx, query, map[string]any{"now": now.Unix()})
	if err != nil {
		return 0, err
	}
	if len(results) != 1 {
		return 0, errors.New("Commander did not return pending OAuth state cleanup results")
	}
	if !strings.HasPrefix(strings.TrimSpace(string(results[0].Result)), "[") {
		return 0, errors.New("Commander returned invalid pending OAuth state cleanup results")
	}
	var records []json.RawMessage
	if err := json.Unmarshal(results[0].Result, &records); err != nil {
		return 0, errors.New("Commander returned invalid pending OAuth state cleanup results")
	}
	for _, record := range records {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(record, &row); err != nil || row == nil {
			return 0, errors.New("Commander returned invalid pending OAuth state cleanup results")
		}
	}
	return len(records), nil
}

func stateRecordID(rawState string) string {
	digest := sha256.Sum256([]byte(rawState))
	return hex.EncodeToString(digest[:])
}

func (s *PendingStore) associatedData(id string) []byte {
	return []byte(fmt.Sprintf("%s\x00%s\x00%s", pendingStateKeyDomain, s.managerID, id))
}
