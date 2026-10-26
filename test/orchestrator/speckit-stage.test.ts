import { describe, expect, it } from 'vitest';
import { tickTasks } from '../../server/orchestrator/phases/speckit.js';

const text = ['# Tasks', '- [ ] T001 Create model', '- [ ] T002 Add route', '- [x] T003 Already done', '- [ ] T004 Later'].join('\n');

describe('Spec Kit tasks.md ticks', () => {
  it('ticks only the ids given, and only the open ones', () => {
    expect(tickTasks(text, ['T001', 'T003'])).toBe(['# Tasks', '- [X] T001 Create model', '- [ ] T002 Add route', '- [x] T003 Already done', '- [ ] T004 Later'].join('\n'));
  });

  it('a second tick changes nothing, and an id the file lacks is ignored', () => {
    const once = tickTasks(text, ['T002']);
    expect(tickTasks(once, ['T002', 'T999'])).toBe(once);
  });

  it('does not tick an id that only shares a prefix', () => {
    expect(tickTasks('- [ ] T0010 Other', ['T001'])).toBe('- [ ] T0010 Other');
  });
});
