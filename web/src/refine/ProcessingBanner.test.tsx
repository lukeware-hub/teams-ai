import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BacklogView } from '../api.js';
import { ProcessingBanner } from './ProcessingBanner.js';

const item = (key: string, rank: number) => ({ key, title: `Spec ${key}`, epic: 'core', scope: 's', priority: 'P1' as const, rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md', heading: '7. OPME' }], size: 'M' as const, rank });
const view = (over: Partial<BacklogView> = {}): BacklogView => ({ enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [item('base', 1), item('casos', 2)], cycle: 2, ...over });

describe('ProcessingBanner', () => {
  it('shows the round, its stage and the backlog being built while the evaluation runs', () => {
    render(<ProcessingBanner backlog={view()} cycle={2} stage="PO e SM revisam os documentos." jevDown={false} />);
    const banner = screen.getByTestId('processing-banner');
    expect(banner.textContent).toContain('Rodada 2 · PO e SM revisam os documentos.');
    expect(banner.textContent).toContain('Avaliação em andamento');
    expect(banner.textContent).toContain('Atualizando a lista de specs');
    expect(screen.queryByTestId('detail-progress')).toBeNull();
  });

  it('names the stage of a new project in its title, in place of the default', () => {
    render(<ProcessingBanner backlog={view()} cycle={2} stage="x" jevDown={false} title="Etapa 2 · Quebrando o backlog" />);
    const banner = screen.getByTestId('processing-banner');
    expect(banner.textContent).toContain('Etapa 2 · Quebrando o backlog');
    expect(banner.textContent).not.toContain('Avaliação em andamento');
  });

  it('shows how far the detailing is, counting specs and pre-plans', () => {
    const detailed = view({
      detail: true,
      specs: { base: { inputHash: 'h', specId: 'p-base', rev: 'r', spec: { specId: 'p-base' }, issues: [], cycle: 2 } } as never,
      preplans: { base: { inputHash: 'h', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 2 } } as never,
    });
    render(<ProcessingBanner backlog={detailed} cycle={2} stage="x" jevDown={false} />);
    expect(screen.getByTestId('detail-progress').textContent).toBe('Detalhando… 1/2 specs · 1/2 pré-planos');
  });

  it('turns red when Jev is down', () => {
    render(<ProcessingBanner backlog={null} cycle={1} stage="Jev indisponível" jevDown />);
    expect(screen.getByTestId('processing-banner').className).toContain('border-bad-line');
  });
});
