import { describe, expect, it } from 'vitest';
import type { RelationSpec } from '../../server/knowledge/relation-links.js';
import { specBrief } from '../../server/knowledge/spec-brief.js';

const spec = (specId: string, over: Partial<RelationSpec> = {}): RelationSpec => ({ specId, dependsOn: [], sources: [], paths: [], ...over });
const specs = [
  spec('login', { repository: 'identity-api', dependsOn: ['tenants'], sources: [{ doc: 'stack.md', heading: 'Auth' }], paths: ['src/login.go'] }),
  spec('tenants', { repository: 'identity-api' }),
  spec('audit', { repository: 'audit-api', dependsOn: ['login'] }),
];

describe('specBrief', () => {
  it('says the service, what the spec needs, what needs it, its neighbours, its sources and its files', () => {
    expect(specBrief(specs, 'login')).toBe(
      [
        '- Service: identity-api',
        '- Needs (finish these first): tenants',
        '- Needed by (do not break their contract): audit',
        '- Other specs of this service: tenants',
        '- Comes from: stack.md › Auth',
        '- Files the plan changes: src/login.go',
      ].join('\n'),
    );
  });

  it('leaves out a line with nothing to say, and is empty for an unknown spec or one with no relation', () => {
    expect(specBrief(specs, 'tenants')).toBe(['- Service: identity-api', '- Needed by (do not break their contract): login', '- Other specs of this service: login'].join('\n'));
    expect(specBrief(specs, 'ghost')).toBe('');
    expect(specBrief([spec('alone')], 'alone')).toBe('');
  });

  it('appends the extra lines, and keeps them for a spec the list does not know', () => {
    expect(specBrief(specs, 'tenants', 1800, ['- Earlier failure of this spec (run 1, blocked): x'])).toContain('- Other specs of this service: login\n- Earlier failure of this spec');
    expect(specBrief(specs, 'ghost', 1800, ['- Earlier failure of this spec (run 1, blocked): x'])).toBe('- Earlier failure of this spec (run 1, blocked): x');
  });

  it('names the first few of a long list and counts the rest, and cuts the whole brief at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    expect(specBrief([spec('a', { dependsOn: many })], 'a')).toBe('- Needs (finish these first): n0, n1, n2, n3, n4, n5, n6, n7 and 4 more');
    expect(specBrief(specs, 'login', 30)).toHaveLength(30);
  });
});
