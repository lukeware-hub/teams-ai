import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as apiMod from '../api.js';
import { OnboardingGate, StatusRedirect } from './OnboardingGate.js';

afterEach(() => vi.restoreAllMocks());

describe('OnboardingGate', () => {
  it('renders children when the environment is incomplete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: false, items: {} } as apiMod.Status);
    render(
      <MemoryRouter>
        <OnboardingGate><p>onboarding body</p></OnboardingGate>
      </MemoryRouter>,
    );
    expect(await screen.findByText('onboarding body')).toBeTruthy();
  });

  it('redirects to settings when the environment is complete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: true, items: {} } as apiMod.Status);
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingGate><p>onboarding body</p></OnboardingGate>} />
          <Route path="/settings" element={<p>settings page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('settings page')).toBeTruthy();
  });
});

describe('StatusRedirect', () => {
  it('goes to /settings when complete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: true, items: {} } as apiMod.Status);
    render(
      <MemoryRouter initialEntries={['/status']}>
        <Routes>
          <Route path="/status" element={<StatusRedirect />} />
          <Route path="/settings" element={<p>settings page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('settings page')).toBeTruthy();
  });

  it('goes to /onboarding when incomplete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: false, items: {} } as apiMod.Status);
    render(
      <MemoryRouter initialEntries={['/status']}>
        <Routes>
          <Route path="/status" element={<StatusRedirect />} />
          <Route path="/onboarding" element={<p>onboarding page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('onboarding page')).toBeTruthy();
  });
});
