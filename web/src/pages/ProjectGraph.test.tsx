import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type GraphView } from '../api.js';
import { ProjectGraph } from './ProjectGraph.js';

const view = (over: Partial<GraphView> = {}): GraphView => ({
  available: true,
  nodes: 3,
  links: 2,
  communities: 2,
  top: [],
  usage: { graph: 4, grep: 1, none: 0, recent: [], queries: { total: 3, steps: 12, byKind: { dev: 2, review: 1 }, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } },
  map: {
    nodes: [
      { id: 'a', label: 'Alpha', repo: 'p', file: 'src/a.go', line: 4, community: 'c1', edges: 2 },
      { id: 'b', label: 'Beta', repo: 'p', file: 'src/b.go', line: null, community: 'c1', edges: 1 },
      { id: 'c', label: 'Gamma', repo: 'p', file: '', line: null, community: 'c2', edges: 1 },
    ],
    links: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
    communities: [{ id: 'c1', name: 'Alpha', size: 2 }, { id: 'c2', name: 'Gamma', size: 1 }],
    truncated: false,
  },
  ...over,
});

const show = () =>
  render(
    <MemoryRouter initialEntries={['/graph/p']}>
      <Routes>
        <Route path="/graph/:projectId" element={<ProjectGraph />} />
      </Routes>
    </MemoryRouter>,
  );

const showBrain = () =>
  render(
    <MemoryRouter initialEntries={['/brain']}>
      <Routes>
        <Route path="/brain" element={<ProjectGraph scope="global" />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('ProjectGraph', () => {
  it('shows the counts, when it was updated and how the agents used it', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ status: { updatedAt: '2026-11-06T15:30:00.000Z', failure: null } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-counts').textContent).toContain('3 nós · 2 ligações · 2 comunidades'));
    expect(screen.getByTestId('graph-updated').textContent).toContain('Atualizado em');
    expect(screen.getByTestId('graph-usage').textContent).toContain('4 pelo grafo');
    expect(screen.queryByTestId('graph-failure')).toBeNull();
    expect(screen.getByTestId('graph-canvas').getAttribute('role')).toBe('img');
  });

  it('shows what the agents asked the graph themselves, by kind of step', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    show();
    await waitFor(() => expect(screen.getByTestId('graph-queries').textContent).toContain('entrega 3 em 12 passos (desenvolvimento 2, revisão 1)'));
    expect(screen.queryByTestId('graph-queries-none')).toBeNull();
  });

  it('counts the refinement and the chat apart, and warns only about the delivery steps', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ usage: { graph: 4, grep: 1, none: 0, recent: [], queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 9 }, chat: { total: 2, steps: 3 } } } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-queries').textContent).toContain('refinamento 0 em 9 passos · chat 2 em 3 respostas'));
    expect(screen.queryByTestId('graph-queries-none')).toBeNull();
  });

  it('says it is not measured yet before the first counted step', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ usage: { graph: 4, grep: 1, none: 0, recent: [], queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-queries').textContent).toContain('ainda não medido'));
    expect(screen.queryByTestId('graph-queries-none')).toBeNull();
  });

  it('warns when many steps were counted and no agent asked the graph anything', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ usage: { graph: 4, grep: 1, none: 0, recent: [], queries: { total: 0, steps: 8, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-queries-none').textContent).toContain('últimos 8 passos'));
  });

  it('warns when the last update failed and says the graph shown is the older one', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ status: { updatedAt: '2026-11-06T15:30:00.000Z', failure: { at: '2026-11-06T16:00:00.000Z', message: 'graphify caiu' } } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-failure').textContent).toContain('graphify caiu'));
    expect(screen.getByTestId('graph-failure').textContent).toContain('versão anterior');
  });

  it('offers to build a graph that does not exist yet, then shows it', async () => {
    const get = vi.spyOn(runApi, 'projectGraph').mockResolvedValueOnce(view({ available: false, map: undefined })).mockResolvedValue(view());
    const build = vi.spyOn(runApi, 'rebuildProjectGraph').mockResolvedValue(undefined as never);
    show();
    await waitFor(() => expect(screen.getByTestId('graph-empty')).toBeTruthy());
    fireEvent.click(screen.getByTestId('graph-build'));
    await waitFor(() => expect(screen.getByTestId('graph-counts')).toBeTruthy());
    expect(build).toHaveBeenCalledWith('p');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('says so when the graph cannot be read', async () => {
    vi.spyOn(runApi, 'projectGraph').mockRejectedValue(new Error('x'));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-error')).toBeTruthy());
  });

  it('turns communities off and on, and all of them with one box', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    show();
    const all = (await screen.findByTestId('graph-select-all')) as HTMLInputElement;
    const first = screen.getByTestId('graph-community-c1') as HTMLInputElement;
    expect(first.checked).toBe(true);
    fireEvent.click(first);
    expect(first.checked).toBe(false);
    expect(all.checked).toBe(false);
    fireEvent.click(all);
    expect(first.checked).toBe(true);
    fireEvent.click(all);
    expect((screen.getByTestId('graph-community-c2') as HTMLInputElement).checked).toBe(false);
  });

  it('finds a node by name and shows it with its file page and neighbours', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    const file = vi.spyOn(runApi, 'projectGraphFile').mockResolvedValue('https://github.com/acme/p/blob/abc/src/a.go#L4');
    show();
    fireEvent.change(await screen.findByTestId('graph-search'), { target: { value: 'alp' } });
    fireEvent.click(screen.getByText('Alpha', { selector: 'ul button' }));
    expect(screen.getByTestId('graph-node-detail').textContent).toContain('src/a.go:4');
    await waitFor(() => expect(screen.getByTestId('graph-node-link').getAttribute('href')).toBe('https://github.com/acme/p/blob/abc/src/a.go#L4'));
    expect(file).toHaveBeenCalledWith('p', 'p', 'src/a.go', 4);
    expect(screen.getByTestId('graph-neighbours').textContent).toContain('Beta');
  });

  it('groups the communities past the twentieth into one line', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `c${i + 1}`, name: `Grupo ${i + 1}`, size: 1 }));
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ map: { ...view().map!, communities: many } }));
    show();
    expect((await screen.findByTestId('graph-community-others')).closest('label')!.textContent).toContain('Outras (5)');
    expect(screen.queryByTestId('graph-community-c21')).toBeNull();
  });

  it('says when the map shows only the most connected nodes', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ nodes: 5000, map: { ...view().map!, truncated: true } }));
    show();
    expect((await screen.findByTestId('graph-truncated')).textContent).toContain('de 5000');
  });

  it('says what the brain of the project holds, by kind, leaving out the kinds with none', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view({ composition: { code: 540, documents: 30, tasks: 12, runs: 8, chat: 0, costs: 1 } }));
    show();
    await waitFor(() => expect(screen.getByTestId('graph-composition').textContent).toBe('Conteúdo: 540 de código · 30 de documentos · 12 de tarefas e critérios · 8 de execuções e falhas · 1 de custos.'));
  });

  it('shows no composition line when the view has none', async () => {
    vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    show();
    await screen.findByTestId('graph-counts');
    expect(screen.queryByTestId('graph-composition')).toBeNull();
  });
});

describe('ProjectGraph as the global brain', () => {
  it('reads the brain, calls each project a group, says confidential projects stay out and has no usage lines', async () => {
    const brain = vi.spyOn(runApi, 'brainGraph').mockResolvedValue(view({ communities: 2 }));
    const project = vi.spyOn(runApi, 'projectGraph').mockResolvedValue(view());
    showBrain();
    await waitFor(() => expect(screen.getByTestId('project-graph-title').textContent).toBe('Cérebro do Teams AI'));
    expect(screen.getByTestId('graph-counts').textContent).toContain('2 projetos');
    expect(screen.getByTestId('brain-note').textContent).toContain('confidencial nunca entra');
    expect(screen.queryByTestId('graph-usage')).toBeNull();
    expect(screen.queryByTestId('graph-queries')).toBeNull();
    expect(brain).toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it('builds the brain when there is none yet, then shows it', async () => {
    const get = vi.spyOn(runApi, 'brainGraph').mockResolvedValueOnce(view({ available: false, map: undefined })).mockResolvedValue(view());
    const build = vi.spyOn(runApi, 'rebuildBrain').mockResolvedValue({});
    showBrain();
    await waitFor(() => expect(screen.getByTestId('graph-empty').textContent).toContain('cérebro do Teams AI ainda não foi construído'));
    fireEvent.click(screen.getByTestId('graph-build'));
    await waitFor(() => expect(screen.getByTestId('graph-counts')).toBeTruthy());
    expect(build).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shows a node with its file name and no GitHub page, since the brain mixes projects', async () => {
    vi.spyOn(runApi, 'brainGraph').mockResolvedValue(view());
    const file = vi.spyOn(runApi, 'projectGraphFile').mockResolvedValue('https://example.com');
    showBrain();
    fireEvent.change(await screen.findByTestId('graph-search'), { target: { value: 'alp' } });
    fireEvent.click(screen.getByText('Alpha', { selector: 'ul button' }));
    expect(screen.getByTestId('graph-node-detail').textContent).toContain('src/a.go:4');
    expect(screen.getByTestId('graph-node-detail').textContent).toContain('projeto Alpha');
    expect(file).not.toHaveBeenCalled();
    expect(screen.queryByTestId('graph-node-link')).toBeNull();
  });

  it('says so when the brain cannot be read', async () => {
    vi.spyOn(runApi, 'brainGraph').mockRejectedValue(new Error('x'));
    showBrain();
    await waitFor(() => expect(screen.getByTestId('graph-error').textContent).toContain('ler o cérebro'));
  });
});
