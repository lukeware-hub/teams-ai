package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"teams-ai/license/internal/auth"
	"teams-ai/license/internal/box"
	"teams-ai/license/internal/httpapi"
	"teams-ai/license/internal/license"
	"teams-ai/license/internal/scheduler"
	"teams-ai/license/internal/store"
)

//go:embed all:static
var staticFiles embed.FS

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	master, err := box.ParseMasterKey(os.Getenv("LICENSE_MASTER_KEY"))
	if err != nil {
		return err
	}
	signer, err := box.ParseSigningKey(os.Getenv("LICENSE_SIGNING_KEY"))
	if err != nil {
		return err
	}
	secret := []byte(os.Getenv("JWT_SECRET"))
	if len(secret) < 16 {
		return errors.New("JWT_SECRET must be at least 16 characters")
	}
	db, err := store.NewPostgres(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := ensureAdmin(ctx, db); err != nil {
		return err
	}
	svc := license.New(db, master, signer, time.Now)
	go scheduler.Start(ctx, time.Minute, func(ctx context.Context) {
		if err := svc.ExpireDue(ctx); err != nil {
			log.Printf("expire licenses: %v", err)
		}
	})
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           httpapi.Handler(httpapi.Deps{Licenses: svc, Secret: secret, Login: login(db, secret), Static: http.FileServer(http.FS(sub))}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", server.Addr)
		errc <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func ensureAdmin(ctx context.Context, db store.Store) error {
	count, err := db.CountAdmins(ctx)
	if err != nil || count > 0 {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(os.Getenv("ADMIN_EMAIL")))
	password := os.Getenv("ADMIN_PASSWORD")
	if email == "" || password == "" {
		return errors.New("ADMIN_EMAIL and ADMIN_PASSWORD are required to create the first administrator")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	return db.CreateAdmin(ctx, newAdminID(), email, hash)
}

func login(db store.Store, secret []byte) func(context.Context, string, string) (string, error) {
	return func(ctx context.Context, email, password string) (string, error) {
		hash, ok, err := db.PasswordHash(ctx, email)
		if err != nil {
			return "", err
		}
		if !ok || !auth.CheckPassword(hash, password) {
			return "", errors.New("invalid credentials")
		}
		return auth.Sign(secret, email, time.Now().Add(auth.TTL))
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func newAdminID() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}
