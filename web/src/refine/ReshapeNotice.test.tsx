import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReshapeRow } from '../api.js';
import { ReshapeNotice } from './ReshapeNotice.js';

const reshape = (over: Partial<ReshapeRow> = {}): ReshapeRow => ({ reshapeId: 'reshape-c1', file: 'briefing.md', cycle: 1, role: 'po', status: 'applied', ...over });
const names = (file: string) => file;

describe('ReshapeNotice', () => {
  it('shows the newest applied reshape, with the document it rewrote', () => {
    render(<ReshapeNotice reshapes={[reshape({ reshapeId: 'reshape-c0', file: 'project.md' }), reshape()]} docName={names} />);
    const notice = screen.getByTestId('reshape-notice');
    expect(notice.textContent).toContain('Reorganizei briefing.md no modelo');
    expect(notice.textContent).not.toContain('project.md');
  });

  it('offers no undo or close action, the agent acted alone', () => {
    render(<ReshapeNotice reshapes={[reshape()]} docName={names} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides a reshape closed for good', () => {
    render(<ReshapeNotice reshapes={[reshape({ closed: true })]} docName={names} />);
    expect(screen.queryByTestId('reshape-notice')).toBeNull();
  });

  it('shows nothing without an applied reshape, such as when the only one was undone', () => {
    render(<ReshapeNotice reshapes={[reshape({ status: 'undone' })]} docName={names} />);
    expect(screen.queryByTestId('reshape-notice')).toBeNull();
  });
});
