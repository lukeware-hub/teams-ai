import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReadinessBanner } from './ReadinessBanner.js';

describe('ReadinessBanner checks', () => {
  it('a check shown as 80% is not marked as below the goal', () => {
    const readiness = {
      available: true,
      model: 'jev',
      average: 0.8,
      usage: null,
      outdated: false,
      skipped: false,
      docs: { 'project.md': { score: 0.8, checks: { complete: 0.796, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } },
    };
    render(<ReadinessBanner readiness={readiness as never} canStart={false} startState={{ label: 'Iniciar', busy: false }} onScore={() => {}} onStart={() => {}} />);
    expect(screen.getByText('completo 80%').className).not.toContain('text-warn');
  });
});
