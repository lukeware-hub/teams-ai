import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageBar } from './StageBar.js';
import { stageOf } from './stages.js';

describe('StageBar', () => {
  it('lists the three stages in order, marks the active one as the current step, and the done ones as done', () => {
    render(<StageBar stages={stageOf({ status: 'ready', stale: false, backlog: { enabled: true, detail: false, items: [{}] } }, false)} />);
    const list = screen.getByRole('list', { name: 'Etapas do refinamento' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('b')?.textContent)).toEqual(['Refinar documentos', 'Quebrar o backlog', 'Executar']);
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[1]!.textContent).toContain('Esboçando o backlog.');
    expect(items[2]!.getAttribute('aria-current')).toBeNull();
  });
});
