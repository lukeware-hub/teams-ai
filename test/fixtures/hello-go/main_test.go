package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func get(path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestEndpoints(t *testing.T) {
	t.Run("[AC-001] hello answers 200 with the message", func(t *testing.T) {
		rec := get("/hello")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"message":"hello"`) {
			t.Fatalf("got %d %s", rec.Code, rec.Body)
		}
	})
	t.Run("[AC-002] health answers ok", func(t *testing.T) {
		rec := get("/health")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"ok"`) {
			t.Fatalf("got %d %s", rec.Code, rec.Body)
		}
	})
	t.Run("[AC-003] unknown path answers 404", func(t *testing.T) {
		if code := get("/nope").Code; code != 404 {
			t.Fatalf("got %d", code)
		}
	})
}
