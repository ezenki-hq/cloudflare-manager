package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestListAccountsAndZonesPagination(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		var result any
		switch r.URL.Path {
		case "/client/v4/accounts":
			if page == "1" {
				result = []Account{{ID: "a1", Name: "one"}}
			} else {
				result = []Account{{ID: "a2", Name: "two"}}
			}
		case "/client/v4/zones":
			if r.URL.Query().Get("account.id") != "a1" {
				t.Errorf("missing account selector: %s", r.URL.RawQuery)
			}
			if page == "1" {
				result = []Zone{{ID: "z1", Name: "one.test"}}
			} else {
				result = []Zone{{ID: "z2", Name: "two.test"}}
			}
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result, "result_info": map[string]any{"page": pageInt(page), "total_pages": 2}})
	}))
	defer server.Close()
	c := NewClient(server.URL, server.Client())
	accounts, err := c.ListAccounts(context.Background(), "user-token")
	if err != nil || len(accounts) != 2 || accounts[1].ID != "a2" {
		t.Fatalf("accounts=%+v err=%v", accounts, err)
	}
	zones, err := c.ListZones(context.Background(), "user-token", "a1")
	if err != nil || len(zones) != 2 || zones[1].ID != "z2" {
		t.Fatalf("zones=%+v err=%v", zones, err)
	}
}

func TestListBucketsReturnsCursor(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("cf-r2-jurisdiction") != "eu" {
			t.Errorf("jurisdiction header=%q", r.Header.Get("cf-r2-jurisdiction"))
		}
		if calls == 1 {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"buckets": []Bucket{{Name: "one"}}}, "result_info": map[string]any{"cursor": "next+/="}})
		} else {
			if r.URL.Query().Get("cursor") != "next+/=" {
				t.Errorf("cursor query=%q", r.URL.Query().Get("cursor"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"buckets": []Bucket{{Name: "two"}}}})
		}
	}))
	defer server.Close()
	c := NewClient(server.URL, server.Client())
	first, err := c.ListBuckets(context.Background(), "token", "account", "eu", "")
	if err != nil || first.Cursor != "next+/=" || len(first.Buckets) != 1 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := c.ListBuckets(context.Background(), "token", "account", "eu", first.Cursor)
	if err != nil || len(second.Buckets) != 1 || second.Buckets[0].Name != "two" || second.Cursor != "" {
		t.Fatalf("second=%+v err=%v", second, err)
	}
}

func TestCloudflareEnvelopeFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []any{map[string]any{"message": "denied"}}})
	}))
	defer server.Close()
	_, err := NewClient(server.URL, server.Client()).ListAccounts(context.Background(), "token")
	if err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("expected sanitized envelope error, got %v", err)
	}
}

func TestDomainUsesZoneAndJurisdiction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/client/v4/accounts/a1/r2/buckets/bucket-one/domains/custom" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("cf-r2-jurisdiction") != "fedramp" {
			t.Errorf("jurisdiction=%q", r.Header.Get("cf-r2-jurisdiction"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["domain"] != "cdn.example.test" || body["zoneId"] != "zone-id" || body["enabled"] != true {
			t.Errorf("body=%v", body)
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{"domain":"cdn.example.test","enabled":true,"zoneId":"zone-id","status":{"ownership":"active"}}}`))
	}))
	defer server.Close()
	if err := NewClient(server.URL, server.Client()).AttachDomain(context.Background(), "token", "a1", "fedramp", "bucket-one", "cdn.example.test", "zone-id"); err != nil {
		t.Fatal(err)
	}
}

func TestS3EndpointJurisdiction(t *testing.T) {
	got, err := S3Endpoint("abc123", "default")
	if err != nil || got != "https://abc123.r2.cloudflarestorage.com" {
		t.Fatalf("default endpoint=%q err=%v", got, err)
	}
	got, err = S3Endpoint("abc123", "eu")
	if err != nil || got != "https://abc123.eu.r2.cloudflarestorage.com" {
		t.Fatalf("eu endpoint=%q err=%v", got, err)
	}
	if _, err = S3Endpoint("abc/123", "eu"); err == nil {
		t.Fatal("accepted unsafe account ID")
	}
}

func TestBucketDeletePreservesContents(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodDelete || r.URL.Path != "/client/v4/accounts/a1/r2/buckets/bucket-one" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{}}`))
	}))
	defer server.Close()
	if err := NewClient(server.URL, server.Client()).DeleteBucket(context.Background(), "token", "a1", "default", "bucket-one"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("got %d requests, want one", calls)
	}
}

func TestInvalidPathInputMakesNoRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer server.Close()
	_, err := NewClient(server.URL, server.Client()).GetBucket(context.Background(), "token", "account/../other", "default", "bucket")
	if err == nil || calls != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestCursorIsEncoded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, _ := url.QueryUnescape(r.URL.RawQuery)
		if !strings.Contains(v, "cursor=next+/=") {
			t.Errorf("raw query=%q", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"success":true,"result":{"buckets":[]}}`))
	}))
	defer server.Close()
	if _, err := NewClient(server.URL, server.Client()).ListBuckets(context.Background(), "token", "a", "default", "next+/="); err != nil {
		t.Fatal(err)
	}
}

func pageInt(s string) int {
	if s == "2" {
		return 2
	}
	return 1
}
