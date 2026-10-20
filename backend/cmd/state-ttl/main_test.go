package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func ttlServer(identity string, queryStatus int, deleted int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "manager-1" || password != "secret-value" {
			http.Error(w, "bad credentials", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/manager":
			_ = json.NewEncoder(w).Encode(map[string]string{"id": identity})
		case "/api/v1/database/query":
			if queryStatus != http.StatusOK {
				http.Error(w, "query failed", queryStatus)
				return
			}
			var body struct {
				Query string `json:"query"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if !strings.Contains(body.Query, "DELETE oauth_pending_state WHERE expires_at <= $now RETURN BEFORE") {
				http.Error(w, "unexpected query", http.StatusBadRequest)
				return
			}
			rows := make([]string, deleted)
			for i := range rows {
				rows[i] = fmt.Sprintf(`{"id":"expired-%d"}`, i)
			}
			_, _ = fmt.Fprintf(w, `{"results":[{"statement":0,"status":"OK","result":[%s]}]}`, strings.Join(rows, ","))
		default:
			http.NotFound(w, r)
		}
	}))
}

func env(api, id, password string) func(string) string {
	values := map[string]string{"MANAGER_API": api, "MANAGER_ID": id, "MANAGER_PASSWORD": password}
	return func(key string) string { return values[key] }
}

func TestRunPrunesOnceAndPrintsOnlyCount(t *testing.T) {
	server := ttlServer("manager-1", http.StatusOK, 3)
	defer server.Close()
	var out strings.Builder
	if err := run(context.Background(), env(server.URL+"/api/v1", "manager-1", "secret-value"), &out); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "Removed 3 expired OAuth states.\n" {
		t.Fatalf("output = %q", got)
	}
	if strings.Contains(out.String(), "secret-value") {
		t.Fatal("output leaked manager password")
	}
}

func TestRunRejectsMissingOrMalformedCredentials(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]string
	}{
		{"missing", map[string]string{"MANAGER_ID": "manager-1", "MANAGER_API": "http://localhost/api/v1"}},
		{"malformed api", map[string]string{"MANAGER_ID": "manager-1", "MANAGER_API": "not-a-url", "MANAGER_PASSWORD": "secret-value"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := run(context.Background(), func(k string) string { return tc.values[k] }, &strings.Builder{}); err == nil {
				t.Fatal("expected configuration failure")
			}
		})
	}
}

func TestRunRejectsDifferentManagerIdentity(t *testing.T) {
	server := ttlServer("other-manager", http.StatusOK, 0)
	defer server.Close()
	err := run(context.Background(), env(server.URL+"/api/v1", "manager-1", "secret-value"), &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("error = %v", err)
	}
}

func TestRunReportsDatabaseFailureWithoutSecrets(t *testing.T) {
	server := ttlServer("manager-1", http.StatusBadGateway, 0)
	defer server.Close()
	err := run(context.Background(), env(server.URL+"/api/v1", "manager-1", "secret-value"), &strings.Builder{})
	if err == nil || strings.Contains(err.Error(), "secret-value") {
		t.Fatalf("error = %v", err)
	}
}
