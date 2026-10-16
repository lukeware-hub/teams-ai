package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"teams-ai/license/internal/auth"
	"teams-ai/license/internal/license"
	"teams-ai/license/internal/store"
)

type Deps struct {
	Licenses *license.Service
	Secret   []byte
	Login    func(ctx context.Context, email, password string) (string, error)
	Static   http.Handler
	Now      func() time.Time
}

type limiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	now    func() time.Time
	limit  int
	window time.Duration
}

func newLimiter(now func() time.Time) *limiter {
	return &limiter{hits: map[string][]time.Time{}, now: now, limit: 30, window: time.Minute}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	keep := l.hits[key][:0]
	for _, at := range l.hits[key] {
		if now.Sub(at) < l.window {
			keep = append(keep, at)
		}
	}
	if len(keep) >= l.limit {
		l.hits[key] = keep
		return false
	}
	l.hits[key] = append(keep, now)
	return true
}

type licenseView struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"`
	ValidForDays *int       `json:"validForDays,omitempty"`
	ActivatedAt  *time.Time `json:"activatedAt,omitempty"`
	DisabledAt   *time.Time `json:"disabledAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	Key          string     `json:"key,omitempty"`
}

func viewOf(lic store.License, key string) licenseView {
	return licenseView{
		ID: lic.ID, Status: string(lic.Status), ExpiresAt: lic.ExpiresAt, ValidForDays: lic.ValidForDays,
		ActivatedAt: lic.ActivatedAt, DisabledAt: lic.DisabledAt, CreatedAt: lic.CreatedAt, Key: key,
	}
}

func Handler(deps Deps) http.Handler {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	limit := newLimiter(deps.Now)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /api/v1/activate", func(w http.ResponseWriter, r *http.Request) {
		if !limit.allow(remote(r)) {
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		var body struct {
			KeyHash string `json:"keyHash"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		code, err := deps.Licenses.Activate(r.Context(), body.KeyHash)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"codeHash": code})
	})
	mux.HandleFunc("POST /api/v1/authorize", func(w http.ResponseWriter, r *http.Request) {
		if !limit.allow(remote(r)) {
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		var body struct {
			CodeHash string `json:"codeHash"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		decision, err := deps.Licenses.Authorize(r.Context(), body.CodeHash)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		if decision.Authorized {
			writeJSON(w, http.StatusOK, map[string]bool{"authorized": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"authorized": false, "reason": decision.Reason,
			"contactEmail": decision.ContactEmail, "contactPhone": decision.ContactPhone,
		})
	})
	mux.HandleFunc("POST /api/admin/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		token, err := deps.Login(r.Context(), strings.TrimSpace(strings.ToLower(body.Email)), body.Password)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"token": token})
	})
	admin := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if token == "" || token == r.Header.Get("Authorization") {
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			if _, err := auth.Subject(deps.Secret, token, deps.Now()); err != nil {
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("GET /api/admin/licenses", admin(func(w http.ResponseWriter, r *http.Request) {
		list, err := deps.Licenses.List(r.Context())
		if err != nil {
			writeAPIError(w, err)
			return
		}
		out := make([]licenseView, 0, len(list))
		for _, lic := range list {
			out = append(out, viewOf(lic, ""))
		}
		writeJSON(w, http.StatusOK, map[string]any{"licenses": out})
	}))
	mux.HandleFunc("POST /api/admin/licenses", admin(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ExpiresAt    *string `json:"expiresAt"`
			ValidForDays *int    `json:"validForDays"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		expiresAt, ok := parseExpiry(w, body.ExpiresAt)
		if !ok {
			return
		}
		lic, key, err := deps.Licenses.Create(r.Context(), expiresAt, body.ValidForDays)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, viewOf(lic, key))
	}))
	mux.HandleFunc("GET /api/admin/licenses/{id}", admin(func(w http.ResponseWriter, r *http.Request) {
		lic, key, err := deps.Licenses.Reveal(r.Context(), r.PathValue("id"))
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, viewOf(lic, key))
	}))
	mux.HandleFunc("PATCH /api/admin/licenses/{id}", admin(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Status       *string `json:"status"`
			ExpiresAt    *string `json:"expiresAt"`
			ValidForDays *int    `json:"validForDays"`
			ClearExpiry  bool    `json:"clearExpiry"`
		}
		raw, ok := readMap(w, r)
		if !ok {
			return
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		var present struct {
			ExpiresAt    json.RawMessage `json:"expiresAt"`
			ValidForDays json.RawMessage `json:"validForDays"`
		}
		_ = json.Unmarshal(raw, &present)
		update := license.Update{ClearExpiry: body.ClearExpiry, HasExpiresAt: len(present.ExpiresAt) > 0, HasValidForDays: len(present.ValidForDays) > 0}
		if body.Status != nil {
			status := store.Status(*body.Status)
			update.Status = &status
		}
		if update.HasExpiresAt {
			expiresAt, good := parseExpiry(w, body.ExpiresAt)
			if !good {
				return
			}
			update.ExpiresAt = expiresAt
		}
		if update.HasValidForDays {
			update.ValidForDays = body.ValidForDays
		}
		lic, err := deps.Licenses.Update(r.Context(), r.PathValue("id"), update)
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, viewOf(lic, ""))
	}))
	mux.HandleFunc("DELETE /api/admin/licenses/{id}", admin(func(w http.ResponseWriter, r *http.Request) {
		if err := deps.Licenses.Delete(r.Context(), r.PathValue("id")); err != nil {
			writeAPIError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /api/admin/settings", admin(func(w http.ResponseWriter, r *http.Request) {
		settings, err := deps.Licenses.Settings(r.Context())
		if err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, settingsJSON(settings))
	}))
	mux.HandleFunc("PUT /api/admin/settings", admin(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ContactEmail string `json:"contactEmail"`
			ContactPhone string `json:"contactPhone"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		settings := store.Settings{ContactEmail: strings.TrimSpace(body.ContactEmail), ContactPhone: strings.TrimSpace(body.ContactPhone)}
		if err := deps.Licenses.SaveSettings(r.Context(), settings); err != nil {
			writeAPIError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, settingsJSON(settings))
	}))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	if deps.Static != nil {
		mux.Handle("/", deps.Static)
	}
	return mux
}

func settingsJSON(settings store.Settings) map[string]string {
	return map[string]string{"contactEmail": settings.ContactEmail, "contactPhone": settings.ContactPhone}
}

func parseExpiry(w http.ResponseWriter, value *string) (*time.Time, bool) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, true
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	if err != nil {
		writeError(w, http.StatusBadRequest, "expiry must be an RFC3339 date")
		return nil, false
	}
	return &parsed, true
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, ok := readMap(w, r)
	if !ok {
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	return true
}

func readMap(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return nil, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return nil, false
	}
	return body, true
}

func writeAPIError(w http.ResponseWriter, err error) {
	if apiErr, ok := err.(*license.Error); ok {
		writeError(w, apiErr.Status, apiErr.Msg)
		return
	}
	writeError(w, http.StatusInternalServerError, "internal error")
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func remote(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
