package main

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/google/uuid"
)

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-Id", uuid.NewString())
	json.NewEncoder(w).Encode(body)
}

func hello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"message": "hello"})
}

func health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"status": "ok"})
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /hello", hello)
	mux.HandleFunc("GET /health", health)
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.ListenAndServe(":"+port, newMux())
}
