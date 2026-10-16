package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"teams-ai/license/migrations"
)

const licenseCols = `id, key_hash, key_ciphertext, code_hash, status, expires_at, valid_for_days, activated_at, disabled_at, created_at, machine`

type Postgres struct {
	pool *pgxpool.Pool
}

func NewPostgres(ctx context.Context, databaseURL string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	store := &Postgres{pool: pool}
	if err := store.Migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (p *Postgres) Close() {
	p.pool.Close()
}

func (p *Postgres) Migrate(ctx context.Context) error {
	_, err := p.pool.Exec(ctx, migrations.SQL)
	return err
}

func (p *Postgres) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `SELECT count(*) FROM admins`).Scan(&n)
	return n, err
}

func (p *Postgres) CreateAdmin(ctx context.Context, id, email, passwordHash string) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO admins (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)`, id, email, passwordHash, time.Now().UTC())
	return err
}

func (p *Postgres) PasswordHash(ctx context.Context, email string) (string, bool, error) {
	var hash string
	err := p.pool.QueryRow(ctx, `SELECT password_hash FROM admins WHERE email = $1`, email).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return hash, true, nil
}

func (p *Postgres) InsertLicense(ctx context.Context, lic License) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO licenses (`+licenseCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		lic.ID, lic.KeyHash, lic.KeyCiphertext, lic.CodeHash, lic.Status, lic.ExpiresAt, lic.ValidForDays, lic.ActivatedAt, lic.DisabledAt, lic.CreatedAt, lic.Machine)
	return err
}

func scanLicense(row pgx.Row) (License, error) {
	var lic License
	err := row.Scan(&lic.ID, &lic.KeyHash, &lic.KeyCiphertext, &lic.CodeHash, &lic.Status, &lic.ExpiresAt, &lic.ValidForDays, &lic.ActivatedAt, &lic.DisabledAt, &lic.CreatedAt, &lic.Machine)
	if errors.Is(err, pgx.ErrNoRows) {
		return License{}, ErrNotFound
	}
	return lic, err
}

func (p *Postgres) FindLicenseByID(ctx context.Context, id string) (License, error) {
	return scanLicense(p.pool.QueryRow(ctx, `SELECT `+licenseCols+` FROM licenses WHERE id = $1`, id))
}

func (p *Postgres) FindLicenseByKeyHash(ctx context.Context, hash string) (License, error) {
	return scanLicense(p.pool.QueryRow(ctx, `SELECT `+licenseCols+` FROM licenses WHERE key_hash = $1`, hash))
}

func (p *Postgres) FindLicenseByCodeHash(ctx context.Context, hash string) (License, error) {
	return scanLicense(p.pool.QueryRow(ctx, `SELECT `+licenseCols+` FROM licenses WHERE code_hash = $1`, hash))
}

func (p *Postgres) ListLicenses(ctx context.Context) ([]License, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+licenseCols+` FROM licenses ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []License
	for rows.Next() {
		lic, err := scanLicense(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, lic)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateLicense(ctx context.Context, lic License) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE licenses
		SET key_hash = $2, key_ciphertext = $3, code_hash = $4, status = $5, expires_at = $6, valid_for_days = $7, activated_at = $8, disabled_at = $9
		WHERE id = $1`,
		lic.ID, lic.KeyHash, lic.KeyCiphertext, lic.CodeHash, lic.Status, lic.ExpiresAt, lic.ValidForDays, lic.ActivatedAt, lic.DisabledAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) DeleteLicense(ctx context.Context, id string) error {
	tag, err := p.pool.Exec(ctx, `DELETE FROM licenses WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) ActivatePending(ctx context.Context, keyHash, codeHash string, activatedAt time.Time, expiresAt *time.Time, machine *Machine) (License, error) {
	row := p.pool.QueryRow(ctx, `
		UPDATE licenses
		SET code_hash = $2, status = 'active', activated_at = $3, expires_at = CASE WHEN $4::timestamptz IS NULL THEN expires_at ELSE $4 END, machine = $5
		WHERE key_hash = $1 AND status = 'pending' AND code_hash IS NULL
		RETURNING `+licenseCols,
		keyHash, codeHash, activatedAt, expiresAt, machine)
	lic, err := scanLicense(row)
	if errors.Is(err, ErrNotFound) {
		return License{}, ErrNotPending
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return License{}, ErrNotPending
	}
	return lic, err
}

func (p *Postgres) ExpireDue(ctx context.Context, now time.Time) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE licenses
		SET status = 'expired', disabled_at = $1
		WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1`, now)
	return err
}

func (p *Postgres) GetSettings(ctx context.Context) (Settings, error) {
	var settings Settings
	err := p.pool.QueryRow(ctx, `SELECT contact_email, contact_phone FROM settings WHERE id = 1`).Scan(&settings.ContactEmail, &settings.ContactPhone)
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, nil
	}
	return settings, err
}

func (p *Postgres) PutSettings(ctx context.Context, settings Settings) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO settings (id, contact_email, contact_phone) VALUES (1, $1, $2)
		ON CONFLICT (id) DO UPDATE SET contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone`,
		settings.ContactEmail, settings.ContactPhone)
	return err
}
