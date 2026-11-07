import { assertService, SERVICE_SUFFIXES } from '../core/ids.js';

/** The kinds of application a repository may hold, in reading order; each has one numbered folder. */
export const APP_KINDS = ['api', 'web', 'mobile'] as const;
export type AppKind = (typeof APP_KINDS)[number];

/** The folder of each kind of application under docs/. */
export const APP_FOLDER: Record<AppKind, string> = { api: '03-api', web: '04-web', mobile: '05-mobile' };

/** The files and folders every repository keeps. A path ending in "/" is a folder that holds at least one file. */
const COMMON: readonly string[] = [
  'README.md',
  '00-visao-geral/produto.md',
  '00-visao-geral/arquitetura.md',
  '00-visao-geral/glossario.md',
  '00-visao-geral/diagramas/',
  '01-onboarding/setup-ambiente.md',
  '01-onboarding/docker-local.md',
  '01-onboarding/primeiros-passos.md',
  '02-padroes/git-flow.md',
  '02-padroes/code-style.md',
  '02-padroes/testes.md',
  '02-padroes/seguranca.md',
  '06-infra-e-deploy/ambientes.md',
  '06-infra-e-deploy/ci-cd.md',
  '06-infra-e-deploy/observabilidade.md',
  '06-infra-e-deploy/runbooks/',
  '06-infra-e-deploy/runbooks/operacao.md',
  '07-decisoes/template.md',
  '08-releases/CHANGELOG.md',
  '08-releases/notas/',
];

/** The files each kind of application keeps, relative to its folder. */
const APP_FILES: Record<AppKind, readonly string[]> = {
  api: ['README.md', 'arquitetura.md', 'autenticacao.md', 'endpoints/', 'openapi.yaml', 'banco-de-dados/modelo.md', 'banco-de-dados/migrations.md', 'integracoes.md', 'erros.md'],
  web: ['README.md', 'arquitetura.md', 'design-system.md', 'rotas-e-telas.md', 'build-e-deploy.md'],
  mobile: ['README.md', 'arquitetura.md', 'telas-e-fluxos.md', 'notificacoes-push.md', 'build-e-publicacao.md', 'dispositivos.md'],
};

/** The paths of one kind of application, each under docs/. */
export const filesOfKind = (kind: AppKind): string[] => APP_FILES[kind].map((file) => `docs/${APP_FOLDER[kind]}/${file}`);

/** Every path of the docs tree, each under docs/: the common ones, then the files of all three kinds of application. */
export const DOCS_TREE: readonly string[] = [...COMMON.map((path) => `docs/${path}`), ...APP_KINDS.flatMap(filesOfKind)];

const SUFFIX_KIND: Record<(typeof SERVICE_SUFFIXES)[number], AppKind> = { api: 'api', jobs: 'api', workflow: 'api', web: 'web', mobile: 'mobile' };

/** The kind of application a service repository holds, from the suffix its name ends with. */
export function kindOfService(service: string): AppKind {
  return SUFFIX_KIND[assertService(service).split('-').at(-1) as keyof typeof SUFFIX_KIND];
}

const DEPLOY_KIND: Partial<Record<string, AppKind>> = { api: 'api', front: 'web', mobile: 'mobile' };

/** The kinds a monolith holds: its deploy targets and whether a front task exists; an api when neither names one. */
export function kindsOfMonolith(deployKinds: readonly string[], frontTask: boolean): AppKind[] {
  const kinds = new Set<AppKind>(frontTask ? ['web'] : []);
  for (const deploy of deployKinds) {
    const kind = DEPLOY_KIND[deploy];
    if (kind) kinds.add(kind);
  }
  return kinds.size > 0 ? APP_KINDS.filter((kind) => kinds.has(kind)) : ['api'];
}
