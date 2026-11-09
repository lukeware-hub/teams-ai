import { describe, expect, it } from 'vitest';
import { DOCS_TREE, filesOfKind, kindOfService, kindsOfMonolith } from '../../server/docs/tree.js';

describe('docs tree', () => {
  it('keeps the common folders and every application folder in every repository', () => {
    expect(DOCS_TREE).toContain('docs/README.md');
    expect(DOCS_TREE).toContain('docs/00-visao-geral/diagramas/');
    expect(DOCS_TREE).toContain('docs/07-decisoes/template.md');
    expect(DOCS_TREE).toContain('docs/03-api/endpoints/');
    expect(DOCS_TREE).toContain('docs/04-web/design-system.md');
    expect(DOCS_TREE).toContain('docs/05-mobile/dispositivos.md');
  });

  it('lists the files of one kind of application under its folder only', () => {
    const mobile = filesOfKind('mobile');
    expect(mobile).toContain('docs/05-mobile/dispositivos.md');
    expect(mobile.every((p) => p.startsWith('docs/05-mobile/'))).toBe(true);
  });
});

describe('kind of a service repository', () => {
  it('reads the kind from the suffix of the service name', () => {
    expect(kindOfService('notification-api')).toBe('api');
    expect(kindOfService('messagem-worker')).toBe('api');
    expect(kindOfService('hospital-web')).toBe('web');
    expect(kindOfService('patient-app')).toBe('mobile');
  });

  it('refuses a service name without a known suffix', () => {
    expect(() => kindOfService('users')).toThrow();
  });
});

describe('kinds of a monolith', () => {
  it('holds an api and a web when its deploy targets name both', () => {
    expect(kindsOfMonolith(['api', 'front'], false)).toEqual(['api', 'web']);
  });

  it('holds a web when a front task exists, even without a front deploy', () => {
    expect(kindsOfMonolith(['mobile'], true)).toEqual(['web', 'mobile']);
  });

  it('falls back to an api when nothing names a kind', () => {
    expect(kindsOfMonolith([], false)).toEqual(['api']);
  });
});
