import { describe, expect, it } from 'vitest';
import { serviceLinks } from '../../server/deploy/service-links.js';

describe('serviceLinks', () => {
  it('builds the app and docs urls for an api inside the published range', () => {
    expect(serviceLinks({ url: 'http://dind:3000', port: 3000, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3000', docsUrl: 'http://localhost:3000/docs' });
  });

  it('gives a front-end only the app url', () => {
    expect(serviceLinks({ url: 'http://dind:3001', port: 3001, kind: 'front', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3001', docsUrl: null });
  });

  it('reads the port from the url of an older report', () => {
    expect(serviceLinks({ url: 'http://dind:3000' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3000', docsUrl: null });
  });

  it('offers no link when the port is outside the published range or unknown', () => {
    expect(serviceLinks({ url: 'http://dind:8080', port: 8080, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'http://dind' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'not a url' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
  });
});
