package license

import (
	"context"
	"testing"
	"time"

	"teams-ai/license/internal/box"
	"teams-ai/license/internal/store"
)

func testService(t *testing.T) (*Service, *time.Time) {
	t.Helper()
	master, err := box.ParseMasterKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	return New(store.NewMemory(), master, func() time.Time { return now }), &now
}

func TestActivateOnceAndReveal(t *testing.T) {
	svc, _ := testService(t)
	ctx := context.Background()
	created, key, err := svc.Create(ctx, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, revealed, err := svc.Reveal(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revealed != key {
		t.Fatalf("revealed key = %q", revealed)
	}
	code, err := svc.Activate(ctx, box.Hash(key))
	if err != nil {
		t.Fatal(err)
	}
	if len(code) != 64 {
		t.Fatalf("code length = %d", len(code))
	}
	if _, err := svc.Activate(ctx, box.Hash(key)); err != ErrAlreadyUsed {
		t.Fatalf("second activate = %v", err)
	}
	decision, err := svc.Authorize(ctx, code)
	if err != nil || !decision.Authorized {
		t.Fatalf("authorize = %+v %v", decision, err)
	}
}

func TestDisableAndEnable(t *testing.T) {
	svc, _ := testService(t)
	ctx := context.Background()
	created, key, err := svc.Create(ctx, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := svc.Activate(ctx, box.Hash(key))
	if err != nil {
		t.Fatal(err)
	}
	disabled := store.StatusDisabled
	if _, err := svc.Update(ctx, created.ID, Update{Status: &disabled}); err != nil {
		t.Fatal(err)
	}
	decision, err := svc.Authorize(ctx, code)
	if err != nil || decision.Authorized || decision.Reason != "disabled" {
		t.Fatalf("authorize = %+v %v", decision, err)
	}
	active := store.StatusActive
	if _, err := svc.Update(ctx, created.ID, Update{Status: &active}); err != nil {
		t.Fatal(err)
	}
	decision, err = svc.Authorize(ctx, code)
	if err != nil || !decision.Authorized {
		t.Fatalf("authorize after enable = %+v %v", decision, err)
	}
}

func TestSchedulerExpiresAndEnableNeedsAFutureDate(t *testing.T) {
	svc, now := testService(t)
	ctx := context.Background()
	days := 1
	created, key, err := svc.Create(ctx, nil, &days)
	if err != nil {
		t.Fatal(err)
	}
	code, err := svc.Activate(ctx, box.Hash(key))
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(25 * time.Hour)
	if err := svc.ExpireDue(ctx); err != nil {
		t.Fatal(err)
	}
	decision, err := svc.Authorize(ctx, code)
	if err != nil || decision.Authorized || decision.Reason != "expired" {
		t.Fatalf("authorize = %+v %v", decision, err)
	}
	active := store.StatusActive
	if _, err := svc.Update(ctx, created.ID, Update{Status: &active}); err != ErrEnable {
		t.Fatalf("enable without a new date = %v", err)
	}
	future := now.Add(48 * time.Hour)
	if _, err := svc.Update(ctx, created.ID, Update{Status: &active, HasExpiresAt: true, ExpiresAt: &future}); err != nil {
		t.Fatal(err)
	}
	decision, err = svc.Authorize(ctx, code)
	if err != nil || !decision.Authorized {
		t.Fatalf("authorize after renewal = %+v %v", decision, err)
	}
}

func TestDeleteRemovesTheLicense(t *testing.T) {
	svc, _ := testService(t)
	ctx := context.Background()
	created, key, err := svc.Create(ctx, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	code, err := svc.Activate(ctx, box.Hash(key))
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Reveal(ctx, created.ID); err != ErrNotFound {
		t.Fatalf("reveal = %v", err)
	}
	decision, err := svc.Authorize(ctx, code)
	if err != nil || decision.Authorized || decision.Reason != "unknown" {
		t.Fatalf("authorize = %+v %v", decision, err)
	}
	if err := svc.Delete(ctx, created.ID); err != ErrNotFound {
		t.Fatalf("second delete = %v", err)
	}
}

func TestDeniedAuthorizationIncludesContact(t *testing.T) {
	svc, _ := testService(t)
	ctx := context.Background()
	if err := svc.SaveSettings(ctx, store.Settings{ContactEmail: "admin@lukeware.com", ContactPhone: "+55 11 0000-0000"}); err != nil {
		t.Fatal(err)
	}
	decision, err := svc.Authorize(ctx, "ab")
	if err != nil {
		t.Fatal(err)
	}
	if decision.Authorized || decision.ContactEmail != "admin@lukeware.com" || decision.ContactPhone != "+55 11 0000-0000" {
		t.Fatalf("decision = %+v", decision)
	}
}
