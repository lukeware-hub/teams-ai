import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Home } from './App.js';
import * as apiMod from './api.js';

afterEach(() => vi.restoreAllMocks());

const app = () => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/projects" element={<p>projects page</p>} />
      <Route path="/onboarding" element={<p>onboarding page</p>} />
    </Routes>
  </MemoryRouter>
);

describe('Home', () => {
  it('goes to /onboarding when the environment is incomplete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: false, items: {} } as apiMod.Status);
    render(app());
    expect(await screen.findByText('onboarding page')).toBeTruthy();
  });

  it('goes to /projects when the environment is complete', async () => {
    vi.spyOn(apiMod.api, 'status').mockResolvedValue({ allOk: true, items: {} } as apiMod.Status);
    render(app());
    expect(await screen.findByText('projects page')).toBeTruthy();
  });
});
