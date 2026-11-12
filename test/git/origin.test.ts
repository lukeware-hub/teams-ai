import { describe, expect, it } from 'vitest';
import { belongsTo, githubSlugOf } from '../../server/git/origin.js';

describe('githubSlugOf', () => {
  it('reads owner and name from an https or ssh address, with or without .git, lower-cased', () => {
    expect(githubSlugOf('https://github.com/Kayron-Hub/Doctor-Web.git')).toBe('kayron-hub/doctor-web');
    expect(githubSlugOf('git@github.com:org/api')).toBe('org/api');
    expect(githubSlugOf('https://github.com/org/api/\n')).toBe('org/api');
  });

  it("gives nothing for an address that is not GitHub's", () => {
    expect(githubSlugOf('/srv/git/api.git')).toBeUndefined();
    expect(githubSlugOf('https://gitlab.com/org/api.git')).toBeUndefined();
  });
});

describe('belongsTo', () => {
  it('holds an address of another owner against it, and nothing else', () => {
    expect(belongsTo('https://github.com/org-old/api', 'kayron-hub')).toBe(false);
    expect(belongsTo('https://github.com/KAYRON-HUB/api', 'kayron-hub')).toBe(true);
    expect(belongsTo('/srv/git/api.git', 'kayron-hub')).toBe(true);
    expect(belongsTo('https://github.com/org-old/api', undefined)).toBe(true);
  });
});
