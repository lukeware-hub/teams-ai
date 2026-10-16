package store

import (
	"context"
	"errors"
	"time"
)

type Status string

const (
	StatusPending  Status = "pending"
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
	StatusExpired  Status = "expired"
)

var ErrNotFound = errors.New("not found")
var ErrNotPending = errors.New("not pending")

type License struct {
	ID            string
	KeyHash       string
	KeyCiphertext string
	CodeHash      *string
	Status        Status
	ExpiresAt     *time.Time
	ValidForDays  *int
	ActivatedAt   *time.Time
	DisabledAt    *time.Time
	CreatedAt     time.Time
}

type Settings struct {
	ContactEmail string
	ContactPhone string
}

type Store interface {
	CountAdmins(ctx context.Context) (int, error)
	CreateAdmin(ctx context.Context, id, email, passwordHash string) error
	PasswordHash(ctx context.Context, email string) (string, bool, error)
	InsertLicense(ctx context.Context, lic License) error
	FindLicenseByID(ctx context.Context, id string) (License, error)
	FindLicenseByKeyHash(ctx context.Context, hash string) (License, error)
	FindLicenseByCodeHash(ctx context.Context, hash string) (License, error)
	ListLicenses(ctx context.Context) ([]License, error)
	UpdateLicense(ctx context.Context, lic License) error
	ActivatePending(ctx context.Context, keyHash, codeHash string, activatedAt time.Time, expiresAt *time.Time) (License, error)
	ExpireDue(ctx context.Context, now time.Time) error
	GetSettings(ctx context.Context) (Settings, error)
	PutSettings(ctx context.Context, settings Settings) error
}
