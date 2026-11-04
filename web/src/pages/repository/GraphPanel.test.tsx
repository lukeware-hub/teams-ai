import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type GraphView } from '../../api.js';
import { GraphPanel } from './GraphPanel.js';

const view = (over: Partial<GraphView> = {}): GraphView => ({
  available: true,
  nodes: 3,
  links: 2,
  communities: 2,
  top: [
    { id: 'a', label: 'A', file: 'a.ts', community: 'core', edges: 2 },
    { id: 'b', label: 'B', file: 'b.ts', community: 'core', edges: 1 },
  ],
  topLinks: [{ source: 'a', target: 'b' }],
  usage: { graph: 4, grep: 1, none: 0, recent: [] },
  ...over,
});

const open = () => {
  const details = screen.getByTestId('repo-graph') as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event('toggle'));
};

afterEach(() => vi.restoreAllMocks());

describe('GraphPanel', () => {
  it('stays closed and fetches nothing until the owner opens it', () => {
    const spy = vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    render(<GraphPanel projectId="p" />);
    expect((screen.getByTestId('repo-graph') as HTMLDetailsElement).open).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows the counts and the agents use once opened, and draws the map only on request', async () => {
    const spy = vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    render(<GraphPanel projectId="p" />);
    open();
    await waitFor(() => expect(screen.getByTestId('graph-counts').textContent).toContain('3 nós · 2 ligações · 2 comunidades'));
    expect(spy).toHaveBeenCalledWith('p');
    expect(screen.getByTestId('graph-usage').textContent).toContain('4 pelo grafo · 1 por busca de texto');
    expect(screen.queryByTestId('graph-map')).toBeNull();
    fireEvent.click(screen.getByTestId('graph-map-toggle'));
    expect(screen.getByTestId('graph-map')).toBeTruthy();
    fireEvent.click(screen.getByTestId('graph-map-toggle'));
    expect(screen.queryByTestId('graph-map')).toBeNull();
  });

  it('says the graph was not built yet when the project has none', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ available: false, top: [], topLinks: [] }));
    render(<GraphPanel projectId="p" />);
    open();
    await waitFor(() => expect(screen.getByTestId('graph-empty')).toBeTruthy());
  });

  it('says the graph could not be read when the request fails', async () => {
    vi.spyOn(runApi, 'projectGraph').mockRejectedValue(new Error('down'));
    render(<GraphPanel projectId="p" />);
    open();
    await waitFor(() => expect(screen.getByTestId('graph-error')).toBeTruthy());
  });

  it('builds the graph on demand and shows it, or the reason the build failed', async () => {
    const get = vi.spyOn(runApi, 'projectGraph').mockResolvedValueOnce(view({ available: false, top: [], topLinks: [] })).mockResolvedValue(view());
    const build = vi.spyOn(runApi, 'rebuildProjectGraph').mockRejectedValueOnce(new Error('não foi possível construir o grafo: sem código')).mockResolvedValue({ ok: true });
    render(<GraphPanel projectId="p" />);
    open();
    await waitFor(() => expect(screen.getByTestId('graph-build')).toBeTruthy());
    fireEvent.click(screen.getByTestId('graph-build'));
    await waitFor(() => expect(screen.getByTestId('graph-build-error').textContent).toContain('sem código'));
    fireEvent.click(screen.getByTestId('graph-build'));
    await waitFor(() => expect(screen.getByTestId('graph-counts')).toBeTruthy());
    expect(build).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
