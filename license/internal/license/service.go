package license

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"teams-ai/license/internal/box"
	"teams-ai/license/internal/store"
)

type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

var (
	ErrNotFound     = &Error{404, "license not found"}
	ErrInvalidKey   = &Error{404, "invalid license key"}
	ErrAlreadyUsed  = &Error{409, "license already registered"}
	ErrInactive     = &Error{403, "license is not active"}
	ErrExclusive    = &Error{400, "set a date or a period, not both"}
	ErrFuture       = &Error{400, "expiry must be in the future"}
	ErrEnable       = &Error{400, "set a future expiry or clear it before enabling"}
	ErrNotActivated = &Error{400, "license is not activated"}
	ErrStatus       = &Error{400, "status must be active or disabled"}
	ErrPeriod       = &Error{400, "period must be at least 1 day"}
)

type Decision struct {
	Authorized   bool
	Reason       string
	ContactEmail string
	ContactPhone string
}

type Update struct {
	Status          *store.Status
	ExpiresAt       *time.Time
	HasExpiresAt    bool
	ValidForDays    *int
	HasValidForDays bool
	ClearExpiry     bool
}

type Service struct {
	store  store.Store
	master []byte
	now    func() time.Time
}

func New(st store.Store, master []byte, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{store: st, master: master, now: now}
}

func (s *Service) Create(ctx context.Context, expiresAt *time.Time, days *int) (store.License, string, error) {
	if expiresAt != nil && days != nil {
		return store.License{}, "", ErrExclusive
	}
	now := s.now()
	if expiresAt != nil && !expiresAt.After(now) {
		return store.License{}, "", ErrFuture
	}
	if days != nil && *days < 1 {
		return store.License{}, "", ErrPeriod
	}
	key, err := box.RandomHex(32)
	if err != nil {
		return store.License{}, "", err
	}
	ciphertext, err := box.Encrypt(s.master, key)
	if err != nil {
		return store.License{}, "", err
	}
	lic := store.License{
		ID:            newID(),
		KeyHash:       box.Hash(key),
		KeyCiphertext: ciphertext,
		Status:        store.StatusPending,
		ExpiresAt:     expiresAt,
		ValidForDays:  days,
		CreatedAt:     now,
	}
	if days != nil {
		lic.ExpiresAt = nil
	}
	if err := s.store.InsertLicense(ctx, lic); err != nil {
		return store.License{}, "", err
	}
	return lic, key, nil
}

func (s *Service) Reveal(ctx context.Context, id string) (store.License, string, error) {
	lic, err := s.one(ctx, id)
	if err != nil {
		return store.License{}, "", err
	}
	key, err := box.Decrypt(s.master, lic.KeyCiphertext)
	if err != nil {
		return store.License{}, "", err
	}
	return lic, key, nil
}

func (s *Service) List(ctx context.Context) ([]store.License, error) {
	return s.store.ListLicenses(ctx)
}

func (s *Service) Activate(ctx context.Context, keyHash string) (string, error) {
	if !hex64(keyHash) {
		return "", ErrInvalidKey
	}
	lic, err := s.store.FindLicenseByKeyHash(ctx, keyHash)
	if errors.Is(err, store.ErrNotFound) {
		return "", ErrInvalidKey
	}
	if err != nil {
		return "", err
	}
	if lic.CodeHash != nil || lic.Status == store.StatusActive {
		return "", ErrAlreadyUsed
	}
	if lic.Status != store.StatusPending {
		return "", ErrInactive
	}
	now := s.now()
	if lic.ExpiresAt != nil && !lic.ExpiresAt.After(now) {
		at := now
		lic.Status = store.StatusExpired
		lic.DisabledAt = &at
		if err := s.store.UpdateLicense(ctx, lic); err != nil {
			return "", err
		}
		return "", ErrInactive
	}
	code, err := box.RandomHex(32)
	if err != nil {
		return "", err
	}
	var expiresAt *time.Time
	if lic.ValidForDays != nil {
		exp := now.Add(time.Duration(*lic.ValidForDays) * 24 * time.Hour)
		expiresAt = &exp
	}
	if _, err := s.store.ActivatePending(ctx, keyHash, box.Hash(code), now, expiresAt); err != nil {
		if errors.Is(err, store.ErrNotPending) || errors.Is(err, store.ErrNotFound) {
			return "", ErrAlreadyUsed
		}
		return "", err
	}
	return code, nil
}

func (s *Service) Authorize(ctx context.Context, code string) (Decision, error) {
	if !hex64(code) {
		return s.deny(ctx, "unknown")
	}
	lic, err := s.store.FindLicenseByCodeHash(ctx, box.Hash(code))
	if errors.Is(err, store.ErrNotFound) {
		return s.deny(ctx, "unknown")
	}
	if err != nil {
		return Decision{}, err
	}
	now := s.now()
	if lic.Status == store.StatusActive && lic.ExpiresAt != nil && !lic.ExpiresAt.After(now) {
		at := now
		lic.Status = store.StatusExpired
		lic.DisabledAt = &at
		if err := s.store.UpdateLicense(ctx, lic); err != nil {
			return Decision{}, err
		}
		return s.deny(ctx, "expired")
	}
	if lic.Status == store.StatusExpired {
		return s.deny(ctx, "expired")
	}
	if lic.Status != store.StatusActive {
		return s.deny(ctx, "disabled")
	}
	return Decision{Authorized: true}, nil
}

func (s *Service) Update(ctx context.Context, id string, in Update) (store.License, error) {
	lic, err := s.one(ctx, id)
	if err != nil {
		return store.License{}, err
	}
	if in.ClearExpiry && (in.HasExpiresAt || in.HasValidForDays) {
		return store.License{}, ErrExclusive
	}
	if in.HasExpiresAt && in.HasValidForDays {
		return store.License{}, ErrExclusive
	}
	now := s.now()
	if in.ClearExpiry {
		lic.ExpiresAt = nil
		lic.ValidForDays = nil
	}
	if in.HasExpiresAt {
		if in.ExpiresAt != nil && !in.ExpiresAt.After(now) {
			return store.License{}, ErrFuture
		}
		lic.ExpiresAt = in.ExpiresAt
		lic.ValidForDays = nil
	}
	if in.HasValidForDays {
		if in.ValidForDays == nil || *in.ValidForDays < 1 {
			return store.License{}, ErrPeriod
		}
		days := *in.ValidForDays
		lic.ValidForDays = &days
		if lic.ActivatedAt != nil {
			exp := lic.ActivatedAt.Add(time.Duration(days) * 24 * time.Hour)
			lic.ExpiresAt = &exp
		} else {
			lic.ExpiresAt = nil
		}
	}
	if in.Status != nil {
		switch *in.Status {
		case store.StatusDisabled:
			at := now
			lic.Status = store.StatusDisabled
			lic.DisabledAt = &at
		case store.StatusActive:
			if lic.CodeHash == nil {
				return store.License{}, ErrNotActivated
			}
			if lic.ExpiresAt != nil && !lic.ExpiresAt.After(now) {
				return store.License{}, ErrEnable
			}
			lic.Status = store.StatusActive
			lic.DisabledAt = nil
		default:
			return store.License{}, ErrStatus
		}
	}
	if lic.Status == store.StatusActive && lic.ExpiresAt != nil && !lic.ExpiresAt.After(now) {
		at := now
		lic.Status = store.StatusExpired
		lic.DisabledAt = &at
	}
	if err := s.store.UpdateLicense(ctx, lic); err != nil {
		return store.License{}, err
	}
	return lic, nil
}

func (s *Service) ExpireDue(ctx context.Context) error {
	return s.store.ExpireDue(ctx, s.now())
}

func (s *Service) Settings(ctx context.Context) (store.Settings, error) {
	return s.store.GetSettings(ctx)
}

func (s *Service) SaveSettings(ctx context.Context, settings store.Settings) error {
	return s.store.PutSettings(ctx, settings)
}

func (s *Service) one(ctx context.Context, id string) (store.License, error) {
	lic, err := s.store.FindLicenseByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return store.License{}, ErrNotFound
	}
	return lic, err
}

func (s *Service) deny(ctx context.Context, reason string) (Decision, error) {
	settings, err := s.store.GetSettings(ctx)
	if err != nil {
		return Decision{}, err
	}
	return Decision{Reason: reason, ContactEmail: settings.ContactEmail, ContactPhone: settings.ContactPhone}, nil
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func hex64(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
