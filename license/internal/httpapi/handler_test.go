package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"teams-ai/license/internal/auth"
	"teams-ai/license/internal/box"
	"teams-ai/license/internal/license"
	"teams-ai/license/internal/store"
)

func TestAdminRoutesRequireJWT(t *testing.T) {
	master, err := box.ParseMasterKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	if err != nil {
		t.Fatal(err)
	}
	memory := store.NewMemory()
	hash, err := auth.HashPassword("secret-pass")
	if err != nil {
		t.Fatal(err)
	}
	if err := memory.CreateAdmin(context.Background(), "admin", "admin@lukeware.com", hash); err != nil {
		t.Fatal(err)
	}
	secret := []byte("jwt-secret")
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	signer := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	svc := license.New(memory, master, signer, func() time.Time { return now })
	handler := Handler(Deps{
		Licenses:      svc,
		Secret:        secret,
		Now:           func() time.Time { return now },
		ClientKey:     testClientKey,
		ClientKeyHash: box.Hash(testTeamsAIKey),
		Login: func(ctx context.Context, email, password string) (string, error) {
			stored, ok, err := memory.PasswordHash(ctx, email)
			if err != nil || !ok || !auth.CheckPassword(stored, password) {
				return "", errOr(err)
			}
			return auth.Sign(secret, email, now.Add(auth.TTL))
		},
	})

	denied := httptest.NewRequest(http.MethodGet, "/api/admin/licenses", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, denied)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}

	loginBody := bytes.NewBufferString(`{"email":"admin@lukeware.com","password":"secret-pass"}`)
	login := httptest.NewRequest(http.MethodPost, "/api/admin/login", loginBody)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, login)
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d body = %s", rec.Code, rec.Body.String())
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &token); err != nil || token.Token == "" {
		t.Fatal(rec.Body.String())
	}
	listed := httptest.NewRequest(http.MethodGet, "/api/admin/licenses", nil)
	listed.Header.Set("Authorization", "Bearer "+token.Token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, listed)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}

	created, key, err := svc.Create(context.Background(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	activateBody := bytes.NewBufferString(`{"keyHash":"` + box.Hash(key) + `","machine":{"fingerprint":"` + fingerprint + `","hostname":"DESKTOP-1","user":"diego","os":"Windows_NT","cpus":8,"addresses":["172.18.0.5"],"macs":["02:42:ac:12:00:05"]}}`)
	activate := httptest.NewRequest(http.MethodPost, "/api/v1/activate", activateBody)
	activate.Header.Set("X-Teams-AI-Key", clientHeader(t, testTeamsAIKey, now))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, activate)
	if rec.Code != http.StatusOK {
		t.Fatalf("activate status = %d body = %s", rec.Code, rec.Body.String())
	}
	var activated struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &activated); err != nil {
		t.Fatal(err)
	}
	body, sig, _ := strings.Cut(activated.Token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(sig)
	if !ed25519.Verify(signer.Public().(ed25519.PublicKey), []byte(body), raw) {
		t.Fatalf("token = %q", activated.Token)
	}
	shown := httptest.NewRequest(http.MethodGet, "/api/admin/licenses/"+created.ID, nil)
	shown.Header.Set("Authorization", "Bearer "+token.Token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, shown)
	var view struct {
		Machine store.Machine `json:"machine"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Machine.Hostname != "DESKTOP-1" || view.Machine.Fingerprint != fingerprint || view.Machine.RemoteIP != "192.0.2.1" || view.Machine.MACs[0] != "02:42:ac:12:00:05" {
		t.Fatalf("machine = %+v", view.Machine)
	}
	deleted := httptest.NewRequest(http.MethodDelete, "/api/admin/licenses/"+created.ID, nil)
	deleted.Header.Set("Authorization", "Bearer "+token.Token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, deleted)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body = %s", rec.Code, rec.Body.String())
	}
	missing := httptest.NewRequest(http.MethodGet, "/api/admin/licenses/"+created.ID, nil)
	missing.Header.Set("Authorization", "Bearer "+token.Token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, missing)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get status = %d", rec.Code)
	}
}

const testTeamsAIKey = "teams-ai-test-key"

var testClientKey = func() *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key
}()

func clientHeader(t *testing.T, key string, at time.Time) string {
	t.Helper()
	plain, _ := json.Marshal(map[string]any{"k": key, "t": at.Unix()})
	sealed, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, &testClientKey.PublicKey, plain, nil)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sealed)
}

func TestClientRoutesRequireTheTeamsAIHeader(t *testing.T) {
	master, err := box.ParseMasterKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	svc := license.New(store.NewMemory(), master, ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize)), func() time.Time { return now })
	handler := Handler(Deps{Licenses: svc, Now: func() time.Time { return now }, ClientKey: testClientKey, ClientKeyHash: box.Hash(testTeamsAIKey)})
	call := func(header string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/authorize", bytes.NewBufferString(`{"codeHash":"ab","fingerprint":""}`))
		if header != "" {
			req.Header.Set("X-Teams-AI-Key", header)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := call(clientHeader(t, testTeamsAIKey, now)); code != http.StatusOK {
		t.Fatalf("valid header = %d", code)
	}
	if code := call(""); code != http.StatusUnauthorized {
		t.Fatalf("missing header = %d", code)
	}
	if code := call(clientHeader(t, "other-key", now)); code != http.StatusUnauthorized {
		t.Fatalf("wrong key = %d", code)
	}
	if code := call(clientHeader(t, testTeamsAIKey, now.Add(-6*time.Minute))); code != http.StatusUnauthorized {
		t.Fatalf("expired header = %d", code)
	}
}

func errOr(err error) error {
	if err != nil {
		return err
	}
	return http.ErrNoCookie
}
