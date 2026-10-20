package commander

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testManagerID = "manager-1"
	testPassword  = "private-password"
)

func TestEveryRequestUsesManagerBasicAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != testManagerID || password != testPassword {
			t.Errorf("Basic auth = (%q, %q, %t), want configured manager", username, password, ok)
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": testManagerID})
	}))
	defer server.Close()

	client := newTestClient(t, server.URL)
	if err := client.VerifyManager(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyManagerRejectsCredentialIdentityMismatch(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"id": "another-manager"})
	})
	defer server.Close()

	err := newTestClient(t, server.URL).VerifyManager(context.Background())
	if err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("VerifyManager error = %v, want identity mismatch", err)
	}
}

func TestListMyResourcesPaginatesUntilTotal(t *testing.T) {
	requests := 0
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/api/v1/resources/mine" || r.URL.Query().Get("type") != "cloudflare-r2-bucket" {
			t.Errorf("unexpected path/query %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		if requests == 1 {
			if r.URL.Query().Get("offset") != "0" {
				t.Errorf("first offset = %q", r.URL.Query().Get("offset"))
			}
			writeJSON(w, http.StatusOK, map[string]any{"items": []any{map[string]any{"id": "resource-1", "manager": testManagerID, "type": "cloudflare-r2-bucket"}}, "limit": 1, "offset": 0, "total": 2})
			return
		}
		if r.URL.Query().Get("offset") != "1" {
			t.Errorf("second offset = %q", r.URL.Query().Get("offset"))
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{map[string]any{"id": "resource-2", "manager": testManagerID, "type": "cloudflare-r2-bucket"}}, "limit": 1, "offset": 1, "total": 2})
	})
	defer server.Close()

	items, err := newTestClient(t, server.URL).ListMyResources(context.Background(), "cloudflare-r2-bucket")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[1].ID != "resource-2" || requests != 2 {
		t.Fatalf("resources=%+v requests=%d, want both pages", items, requests)
	}
}

func TestGetResourceRejectsResourceOwnedByAnotherManager(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"resource": map[string]any{"id": "resource-1", "manager": "another-manager", "type": "cloudflare-r2-bucket"},
			"config":   map[string]any{"metadata": map[string]any{}},
		})
	})
	defer server.Close()

	if _, err := newTestClient(t, server.URL).GetResource(context.Background(), "resource-1"); err == nil {
		t.Fatal("GetResource accepted a resource owned by a different manager")
	}
}

func TestCreateConnectionUsesBeneficiaryManagerField(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/connections" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["connect_manager_id"] != "app-manager" || body["resource_id"] != "resource-1" || body["manager_id"] != nil {
			t.Errorf("connection request body = %#v", body)
		}
		writeJSON(w, http.StatusCreated, connectionDetailJSON("connection-1", "resource-1", "app-manager", testManagerID, map[string]any{}))
	})
	defer server.Close()

	created, err := newTestClient(t, server.URL).CreateConnection(context.Background(), ConnectionCreate{
		ManagerID: "app-manager", ResourceID: "resource-1", Metadata: map[string]any{"status": "pending"}, Labels: map[string]string{"custom_deployer_group_id": "group-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Connection.ID != "connection-1" {
		t.Fatalf("created connection ID = %q", created.Connection.ID)
	}
}

func TestUpdateConnectionReplacesMetadata(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/api/v1/connections/connection-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		metadata := body["metadata"].(map[string]any)
		if metadata["status"] != "ready" || len(metadata) != 1 {
			t.Errorf("metadata patch = %#v", metadata)
		}
		w.WriteHeader(http.StatusOK)
	})
	defer server.Close()

	if err := newTestClient(t, server.URL).UpdateConnection(context.Background(), "connection-1", map[string]any{"status": "ready"}); err != nil {
		t.Fatal(err)
	}
}

func TestConnectionLabelRoutesUseComponentScopedPaths(t *testing.T) {
	var methods []string
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.EscapedPath())
		w.WriteHeader(http.StatusNoContent)
	})
	defer server.Close()

	client := newTestClient(t, server.URL)
	if err := client.PutConnectionLabel(context.Background(), "connection-1", "custom_deployer_group_id", "group/one"); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteConnectionLabel(context.Background(), "connection-1", "custom_deployer_connection_origin"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"PUT /api/v1/connections/connection-1/labels/custom_deployer_group_id",
		"DELETE /api/v1/connections/connection-1/labels/custom_deployer_connection_origin",
	}
	if fmt.Sprint(methods) != fmt.Sprint(want) {
		t.Fatalf("label requests=%v, want %v", methods, want)
	}
}

func TestCommanderErrorsNeverEchoPassword(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict, http.StatusBadGateway} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"message":"` + testPassword + `"}}`))
			})
			defer server.Close()
			err := newTestClient(t, server.URL).VerifyManager(context.Background())
			if err == nil || strings.Contains(err.Error(), testPassword) || !strings.Contains(err.Error(), fmt.Sprint(status)) {
				t.Fatalf("error = %v, want safe status %d without credentials", err, status)
			}
		})
	}
}

func TestDatabaseQuerySendsBoundValuesWithoutInlining(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/database/query" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["query"] != "RETURN $value" || body["bindings"].(map[string]any)["value"] != "bound" {
			t.Errorf("query request = %#v", body)
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{map[string]any{"statement": 0, "status": "OK", "result": "bound"}}})
	})
	defer server.Close()
	results, err := newTestClient(t, server.URL).DatabaseQuery(context.Background(), "RETURN $value", map[string]any{"value": "bound"})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Statement != 0 || results[0].Status != "OK" || string(results[0].Result) != `"bound"` {
		t.Fatalf("results = %#v", results)
	}
}

func TestDatabaseQueryOmitsBindingsWhenAbsent(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if _, exists := body["bindings"]; exists {
			t.Errorf("query with no bindings sent bindings field: %#v", body)
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{map[string]any{"statement": 0, "status": "OK", "result": nil}}})
	})
	defer server.Close()
	if _, err := newTestClient(t, server.URL).DatabaseQuery(context.Background(), "RETURN 1", nil); err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseQueryRejectsFailedOrMalformedResults(t *testing.T) {
	for name, body := range map[string]string{
		"empty results":        `{"results":[]}`,
		"failed status":        `{"results":[{"statement":0,"status":"ERR","result":"query failed"}]}`,
		"missing status":       `{"results":[{"statement":0,"result":[]}]}`,
		"missing envelope":     `{"result":[]}`,
		"out of order indexes": `{"results":[{"statement":1,"status":"OK","result":[]}]}`,
		"malformed JSON":       `{"results":[`,
	} {
		t.Run(name, func(t *testing.T) {
			server := jsonServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
			defer server.Close()
			results, err := newTestClient(t, server.URL).DatabaseQuery(context.Background(), "RETURN 1", nil)
			if err == nil || results != nil || strings.Contains(err.Error(), "query failed") {
				t.Fatalf("results=%#v error=%v; want safe failure", results, err)
			}
		})
	}
}

func TestDatabaseQueryRejectsAnyFailedStatement(t *testing.T) {
	server := jsonServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"results": []any{
			map[string]any{"statement": 0, "status": "OK", "result": []any{}},
			map[string]any{"statement": 1, "status": "ERR", "result": "private details"},
		}})
	})
	defer server.Close()
	results, err := newTestClient(t, server.URL).DatabaseQuery(context.Background(), "RETURN 1; RETURN 2", nil)
	if err == nil || results != nil || strings.Contains(err.Error(), "private details") {
		t.Fatalf("results=%#v error=%v; want safe failure", results, err)
	}
}

func newTestClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient(baseURL+"/api/v1", testManagerID, testPassword, nil)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func jsonServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != testManagerID || password != testPassword {
			t.Errorf("Basic auth = (%q, %q, %t)", username, password, ok)
		}
		handler(w, r)
	}))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func connectionDetailJSON(id, resource, manager, owner string, metadata map[string]any) map[string]any {
	return map[string]any{
		"connection": map[string]any{"id": id, "manager": manager, "resource": resource, "created_at": "now", "labels": map[string]string{}},
		"config":     map[string]any{"id": id, "manager": manager, "resource": resource, "metadata": metadata, "resource_manager": owner},
	}
}
