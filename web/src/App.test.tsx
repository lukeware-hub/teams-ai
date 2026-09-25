import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Home } from './App.js';

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
  it('goes to /projects when a project is registered, else to /onboarding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{ projectId: 'p', dir: '/p', specs: [] }]), { status: 200 }));
    const first = render(app());
    expect(await screen.findByText('projects page')).toBeTruthy();
    first.unmount();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    render(app());
    expect(await screen.findByText('onboarding page')).toBeTruthy();
  });
});
