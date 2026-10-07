import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Item, type Snapshot, type Status } from '../api.js';
import type { StoredEvent } from '../api.js';
import { JevActions, RefinementView } from './Refinement.js';

const green = (ids: string[]) => ids.map((id) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];

const base = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  docs: { 'project.md': '# Hello', 'brief.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [{ name: 'DB_URL', present: false, hint: null }],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: {
    status: 'answering',
    stale: false,
    cycle: 1,
    derived: { spec: { type: 'feature', acceptanceCriteria: [], externalDependencies: [{ name: 'db', secretNames: ['DB_URL'] }] }, project: {} },
    checklist: green(ALL),
    questions: [
      { questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: ['AC-001'], cycle: 1, status: 'pending', answer: null },
      { questionId: 'sm-c1-0', role: 'sm', text: 'DB?', blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null },
    ],
    patches: [{ patchId: 'sm-c1-0', role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'clearer', diff: '--- brief.md\n-a\n+b\n', cycle: 1, status: 'pending', decision: null }],
    discarded: [{ cycle: 1, role: 'po', file: 'docs/project.md', reason: 'find not found in project.md' }],
    error: null,
    runId: null,
    ...over,
  },
});
const on = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type, kind: 'fact', data });

describe('RefinementView backlog mode', () => {
  const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], cycle: 1, items: [{ key: 'base', title: 'Fundação', epic: 'core', scope: 'Esqueleto', priority: 'P0' as const, rationale: 'tudo depende', dependsOn: [], sources: [{ doc: 'brief.md', heading: 'Objectives' }], size: 'S' as const, rank: 1 }] };
  const ready = { status: 'ready' as const, questions: [], patches: [], discarded: [], derived: null };

  it('offers to break the docs into a backlog, and asks the page to enable it', () => {
    const h = { ...on(), onEnableBacklog: vi.fn() };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: null })} busy={false} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(h.onEnableBacklog).toHaveBeenCalledOnce();
  });

  it('offers specs.json instead of spec.json and tasks, and project.json from the backlog run', () => {
    const withProject = { ...backlog, project: { projectId: 'hello-app' } };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: withProject })} busy={false} {...on()} /></MemoryRouter>);
    const specs = screen.getByTestId('download-specs-json') as HTMLAnchorElement;
    expect(decodeURIComponent(specs.href)).toContain('"specId": "hello-001-base"');
    expect(screen.queryByTestId('download-spec-json')).toBeNull();
    expect(screen.queryByText(/Nenhuma tarefa gerada/)).toBeNull();
    expect(screen.getByTestId('download-project-json')).toBeTruthy();
  });

  it('shows the backlog and keeps Start disabled even when the session is ready', () => {
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByTestId('item-base')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/backlog está pronto para revisão/i)).toBeTruthy();
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
  });
});

describe('RefinementView', () => {
  it('shows the blocking question first without a skip button, patches with accept/reject, and disables Start while answering', () => {
    const h = on();
    render(
      <MemoryRouter>
        <RefinementView snap={base({})} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Port?')).toBeTruthy();
    expect(screen.queryByTestId('skip-po-c1-0')).toBeNull();
    fireEvent.change(screen.getByTestId('answer'), { target: { value: '8080' } });
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080');
    fireEvent.click(screen.getByTestId('accept-sm-c1-0'));
    expect(h.onAccept).toHaveBeenCalledWith('sm-c1-0');
    expect(screen.getByText(/find not found in project.md/)).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Reavaliar')).toBeTruthy();
  });

  it('saves a doc on blur, enables Start only when ready and not stale, and shows secrets rows', () => {
    const h = on();
    const { rerender } = render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'ready', questions: [], patches: [] })} busy={false} {...h} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('doc-brief.md'), { target: { value: '## Objectives\n- ship' } });
    fireEvent.blur(screen.getByTestId('doc-brief.md'));
    expect(h.onSaveDoc).toHaveBeenCalledWith('brief.md', '## Objectives\n- ship');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('secret-DB_URL'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('save-secret-DB_URL'));
    expect(h.onSecret).toHaveBeenCalledWith('DB_URL', 'x');
    rerender(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'ready', stale: true, questions: [], patches: [] })} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('stale')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks the editor and the evaluate button while evaluating and leaves cycle errors to the page alert', () => {
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'evaluating', questions: [], patches: [] })} busy={true} {...on()} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId('doc-brief.md') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(true);
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'error', error: 'derive: spec.objectives: too small', questions: [], patches: [] })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/spec.objectives: too small/)).toBeNull();
  });

  it('shows no question and no patch decision while an evaluation runs: the server refuses them, and they show up once it ends', () => {
    const { rerender } = render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'evaluating' })} busy={true} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('answer')).toBeNull();
    expect(screen.queryByTestId('accept-sm-c1-0')).toBeNull();
    expect(screen.queryByTestId('reject-sm-c1-0')).toBeNull();
    expect(screen.getByText(/aparecem aqui quando a avaliação terminar/)).toBeTruthy();
    rerender(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'answering' })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('answer')).toBeTruthy();
    expect((screen.getByTestId('accept-sm-c1-0') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('reject-sm-c1-0') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/aparecem aqui quando a avaliação terminar/)).toBeNull();
  });

  it('explains that Jev is required in refinement and keeps re-evaluation available', () => {
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'error', error: 'Jev bloqueou a derivação: flow_covers_scope', questions: [], patches: [] })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/O Jev é obrigatório no refinamento/)).toBeTruthy();
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the active Claude step from the refinement journal', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({ status: 'evaluating', questions: [], patches: [] })}
          busy={true}
          events={[
            event(1, 'REFINE_CYCLE_STARTED', { cycle: 1 }),
            event(2, 'REFINE_DOCS_VALIDATED', { cycle: 1, available: true }),
            event(3, 'STEP_STARTED', { stepId: 'step-1', kind: 'derive', role: 'po', attempt: 1 }),
          ]}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/derivando project\.json e spec\.json/)).toBeTruthy();
  });

  it('turns the evaluation card red when Jev is unavailable', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({ status: 'evaluating', questions: [], patches: [] })}
          busy={true}
          events={[event(1, 'REFINE_DOCS_VALIDATED', { cycle: 1, available: false })]}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').className).toContain('claude-session-bad');
  });

  it('shows the demand type, bug details, and downloadable derived JSON', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({
            status: 'ready',
            questions: [],
            patches: [],
            derived: {
              project: {},
              spec: {
                type: 'bug',
                bug: { actual: '500', expected: '200', reproduction: 'GET /todos' },
                acceptanceCriteria: [],
                externalDependencies: [],
              },
            },
          })}
          busy={false}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('doc-impact').textContent).toContain('spec.json');
    expect(screen.getByTestId('spec-type').textContent).toContain('Bug');
    expect(screen.getByTestId('bug-details').textContent).toContain('GET /todos');
    expect(screen.getByTestId('download-spec-json').getAttribute('download')).toBe('spec.json');
    expect(screen.getByTestId('download-project-json').getAttribute('download')).toBe('project.json');
  });
});

describe('JevActions', () => {
  const status = (openrouterKey: Item) => ({ items: { openrouterKey }, allOk: false }) as unknown as Status;

  it('links to the OpenRouter onboarding step and reports a failed connection check', async () => {
    vi.spyOn(api, 'status').mockResolvedValue(status({ ok: false, detail: 'OPENROUTER_API_KEY not set' }));
    render(<MemoryRouter><JevActions /></MemoryRouter>);
    expect(screen.getByText('Informar nova chave').getAttribute('href')).toBe('/onboarding?item=openrouter');
    fireEvent.click(screen.getByTestId('jev-validate'));
    expect((await screen.findByTestId('jev-validate-result')).textContent).toContain('Falha na conexão: OPENROUTER_API_KEY not set');
  });

  it('confirms a working connection', async () => {
    vi.spyOn(api, 'status').mockResolvedValue(status({ ok: true, detail: 'ok' }));
    render(<MemoryRouter><JevActions /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('jev-validate'));
    expect((await screen.findByTestId('jev-validate-result')).textContent).toContain('Conexão com o OpenRouter funcionando');
  });
});
