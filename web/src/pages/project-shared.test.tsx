import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { chip } from './project-shared.js';

describe('chip', () => {
  it('names a spec retired from the backlog in Portuguese (R11.7.5)', () => {
    render(chip('retired'));
    expect(screen.getByText('retirada')).toBeTruthy();
  });
});
