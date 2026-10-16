package store

import (
	"context"
	"sort"
	"sync"
	"time"
)

type admin struct {
	id   string
	hash string
}

type Memory struct {
	mu       sync.Mutex
	admins   map[string]admin
	byID     map[string]License
	byKey    map[string]string
	byCode   map[string]string
	settings Settings
}

func NewMemory() *Memory {
	return &Memory{
		admins: map[string]admin{},
		byID:   map[string]License{},
		byKey:  map[string]string{},
		byCode: map[string]string{},
	}
}

func cloneLicense(lic License) License {
	if lic.CodeHash != nil {
		value := *lic.CodeHash
		lic.CodeHash = &value
	}
	if lic.ExpiresAt != nil {
		value := *lic.ExpiresAt
		lic.ExpiresAt = &value
	}
	if lic.ValidForDays != nil {
		value := *lic.ValidForDays
		lic.ValidForDays = &value
	}
	if lic.ActivatedAt != nil {
		value := *lic.ActivatedAt
		lic.ActivatedAt = &value
	}
	if lic.DisabledAt != nil {
		value := *lic.DisabledAt
		lic.DisabledAt = &value
	}
	return lic
}

func (m *Memory) CountAdmins(context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.admins), nil
}

func (m *Memory) CreateAdmin(_ context.Context, id, email, passwordHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.admins[email] = admin{id: id, hash: passwordHash}
	return nil
}

func (m *Memory) PasswordHash(_ context.Context, email string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	admin, ok := m.admins[email]
	if !ok {
		return "", false, nil
	}
	return admin.hash, true, nil
}

func (m *Memory) InsertLicense(_ context.Context, lic License) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byID[lic.ID] = cloneLicense(lic)
	m.byKey[lic.KeyHash] = lic.ID
	if lic.CodeHash != nil {
		m.byCode[*lic.CodeHash] = lic.ID
	}
	return nil
}

func (m *Memory) FindLicenseByID(_ context.Context, id string) (License, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	lic, ok := m.byID[id]
	if !ok {
		return License{}, ErrNotFound
	}
	return cloneLicense(lic), nil
}

func (m *Memory) FindLicenseByKeyHash(_ context.Context, hash string) (License, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.findLocked(m.byKey, hash)
}

func (m *Memory) FindLicenseByCodeHash(_ context.Context, hash string) (License, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.findLocked(m.byCode, hash)
}

func (m *Memory) findLocked(index map[string]string, hash string) (License, error) {
	id, ok := index[hash]
	if !ok {
		return License{}, ErrNotFound
	}
	return cloneLicense(m.byID[id]), nil
}

func (m *Memory) ListLicenses(context.Context) ([]License, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]License, 0, len(m.byID))
	for _, lic := range m.byID {
		out = append(out, cloneLicense(lic))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *Memory) UpdateLicense(_ context.Context, lic License) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev, ok := m.byID[lic.ID]
	if !ok {
		return ErrNotFound
	}
	if prev.CodeHash != nil {
		delete(m.byCode, *prev.CodeHash)
	}
	m.byID[lic.ID] = cloneLicense(lic)
	m.byKey[lic.KeyHash] = lic.ID
	if lic.CodeHash != nil {
		m.byCode[*lic.CodeHash] = lic.ID
	}
	return nil
}

func (m *Memory) ActivatePending(_ context.Context, keyHash, codeHash string, activatedAt time.Time, expiresAt *time.Time) (License, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byKey[keyHash]
	if !ok {
		return License{}, ErrNotFound
	}
	lic := m.byID[id]
	if lic.Status != StatusPending || lic.CodeHash != nil {
		return License{}, ErrNotPending
	}
	value := codeHash
	lic.CodeHash = &value
	lic.Status = StatusActive
	at := activatedAt
	lic.ActivatedAt = &at
	if expiresAt != nil {
		exp := *expiresAt
		lic.ExpiresAt = &exp
	}
	m.byID[id] = cloneLicense(lic)
	m.byCode[codeHash] = id
	return cloneLicense(lic), nil
}

func (m *Memory) ExpireDue(_ context.Context, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, lic := range m.byID {
		if lic.Status == StatusActive && lic.ExpiresAt != nil && !lic.ExpiresAt.After(now) {
			at := now
			lic.Status = StatusExpired
			lic.DisabledAt = &at
			m.byID[id] = lic
		}
	}
	return nil
}

func (m *Memory) GetSettings(context.Context) (Settings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.settings, nil
}

func (m *Memory) PutSettings(_ context.Context, settings Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settings = settings
	return nil
}
