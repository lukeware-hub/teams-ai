import { describe, expect, it } from 'vitest';
import type { LastDeploy, ServiceStatus } from '../../api.js';
import { shortcutsOf, systemHrefOf } from './shortcuts.js';

const HOST = 'localhost';
const deploy = (over: Partial<LastDeploy> = {}): LastDeploy => ({ runId: 'r1', specId: 'cart', url: 'http://localhost:3001', kind: null, docsPath: '/docs', healthcheckPath: null, services: null, ...over });
const probe = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({ online: true, status: 200, ui: true, docs: true, checkedAt: '2026-11-01T10:00:00.000Z', ...over });

describe('the buttons of a repository, by its kind', () => {
  it('shows the Swagger button for an API, open while the probe answers for its documentation', () => {
    expect(shortcutsOf('api', 'shop-api', deploy(), probe(), HOST)).toEqual([{ kind: 'swagger', href: 'http://localhost:3001/docs', reason: null }]);
  });

  it('shows the application button for a web repository, open while the probe sees its page', () => {
    expect(shortcutsOf('web', 'shop-web', deploy(), probe(), HOST)).toEqual([{ kind: 'app', href: 'http://localhost:3001', reason: null }]);
  });

  it('shows both buttons for a monolith, and only the Swagger for workers', () => {
    expect(shortcutsOf('monolith', 'live-skill', deploy(), probe(), HOST).map((s) => s.kind)).toEqual(['swagger', 'app']);
    expect(shortcutsOf('worker', 'worker', deploy(), probe(), HOST).map((s) => s.kind)).toEqual(['swagger']);
  });

  it('shows no button for a mobile or workflow repository', () => {
    expect(shortcutsOf('mobile', 'app', deploy(), probe(), HOST)).toEqual([]);
    expect(shortcutsOf('workflow', 'flow', deploy(), probe(), HOST)).toEqual([]);
  });
});

describe('a button with nothing to open', () => {
  it('shows the Swagger button blocked, with its reason, when the plan declares no documentation, and keeps the application reason', () => {
    const monolith = shortcutsOf('monolith', 'live-skill', deploy({ docsPath: null }), probe({ ui: false, docs: false }), HOST);
    expect(monolith).toEqual([{ kind: 'swagger', href: null, reason: 'Swagger não existe' }, { kind: 'app', href: null, reason: 'a aplicação não responde na raiz' }]);
  });

  it('keeps the Swagger button blocked, with its reason, when the plan declares no documentation; the application button stays hidden for an API', () => {
    expect(shortcutsOf('monolith', 'live-skill', deploy({ kind: 'api', docsPath: null }), probe({ ui: false, docs: false }), HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'Swagger não existe' }]);
  });

  it('hides the application button of an API even when it declares its documentation', () => {
    expect(shortcutsOf('monolith', 'shop', deploy({ kind: 'api' }), probe({ ui: false }), HOST).map((s) => s.kind)).toEqual(['swagger']);
  });
});

describe('a button that cannot open yet', () => {

  it('says the documentation does not answer when the declared path fails', () => {
    expect(shortcutsOf('api', 'shop-api', deploy(), probe({ docs: false }), HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'a documentação não responde' }]);
  });

  it('says the system is down while the probe does not answer', () => {
    expect(shortcutsOf('api', 'shop-api', deploy(), probe({ online: false }), HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'sistema desligado' }]);
  });

  it('says there is no data before any deploy, and that it is checking while the probe is on its way', () => {
    expect(shortcutsOf('api', 'shop-api', null, null, HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'sem dados: nenhum deploy verificado ainda' }]);
    expect(shortcutsOf('api', 'shop-api', deploy(), null, HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'verificando se o sistema responde' }]);
  });
});

describe('the address a browser opens', () => {
  it('takes the address of the repository\'s own service when the deploy has several', () => {
    const multi = deploy({ url: null, docsPath: null, services: [{ service: 'shop-api', url: 'http://localhost:3002', docsPath: '/swagger', healthcheckPath: null }] });
    const answers = probe({ services: [{ service: 'shop-api', online: true, status: 200, ui: false, docs: true }] });
    expect(shortcutsOf('api', 'shop-api', multi, answers, HOST)).toEqual([{ kind: 'swagger', href: 'http://localhost:3002/swagger', reason: null }]);
  });

  it('names the browser host instead of the internal one, on the published port', () => {
    const internal = deploy({ url: 'http://dind:20074', docsPath: '/docs' });
    expect(shortcutsOf('api', 'shop-api', internal, probe(), 'shop.lan')).toEqual([{ kind: 'swagger', href: 'http://shop.lan:20074/docs', reason: null }]);
  });

  it('gives no link to a port the platform does not publish, and says why', () => {
    expect(shortcutsOf('api', 'shop-api', deploy({ url: 'http://dind:8080' }), probe(), HOST)).toEqual([{ kind: 'swagger', href: null, reason: 'a porta do serviço não está publicada' }]);
  });
});

describe('a probe that failed', () => {
  it('says it could not check the system, not that it is still checking', () => {
    expect(shortcutsOf('api', 'shop-api', deploy(), null, HOST, true)).toEqual([{ kind: 'swagger', href: null, reason: 'não foi possível verificar o sistema' }]);
  });
});
