import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.js';

describe('Markdown', () => {
  it('renders headings, lists, code and safe links without raw HTML', () => {
    const { container } = render(<Markdown source={'# Hello\n\nA **bold** `code` [site](https://x.dev) [bad](javascript:alert(1)) <b>raw</b>\n\n- one\n- two\n\n```\nnpm test\n```'} />);
    expect(container.querySelector('h3')!.textContent).toBe('Hello');
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre code')!.textContent).toBe('npm test');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://x.dev');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>raw</b>');
  });
});
