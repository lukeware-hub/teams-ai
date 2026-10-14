import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Select } from './Select.js';

describe('Select', () => {
  it('is a real select with its own arrow, so keyboard and screen readers keep working', () => {
    let chosen = '';
    render(<Select aria-label="Status" onChange={(e) => (chosen = e.target.value)}><option value="a">A</option><option value="b">B</option></Select>);
    const select = screen.getByRole('combobox', { name: 'Status' });
    expect(select.className).toContain('appearance-none');
    expect(select.parentElement?.querySelector('svg')).not.toBeNull();
    fireEvent.change(select, { target: { value: 'b' } });
    expect(chosen).toBe('b');
  });
});
