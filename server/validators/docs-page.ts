import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';

/** Names the API's documentation page: Swagger, OpenAPI, a /docs path or the API documentation. */
const DOCS_PAGE = /swagger|openapi|[/-]docs\b|documenta[çc][ãa]o da api|api documentation|api docs/i;
/** Refuses the page rather than asking for it. */
const REFUSED = /\b(not|never|without|nunca|sem|não|nao|404)\b/i;

/** True when an objective, a feature or a criterion of the spec asks for the documentation page and does not refuse it. */
export function asksForDocsPage(spec: Spec): boolean {
  const units = [...spec.objectives, ...spec.features, ...spec.acceptanceCriteria.map((ac) => [ac.given, ac.when, ac.then].join(' '))];
  return units.some((unit) => DOCS_PAGE.test(unit) && !REFUSED.test(unit));
}

/** The errors of a deploy's documentation path against what the spec asks; a mobile deploy has no service page. */
export function docsPageErrors(deploy: Pick<Plan['deploy'], 'kind' | 'docsPath'>, tasks: readonly Pick<PlanTask, 'title' | 'description' | 'affectedPaths'>[], spec: Spec): string[] {
  if (deploy.kind === 'mobile') return [];
  const asks = asksForDocsPage(spec);
  const docsPath = deploy.docsPath;
  if (docsPath === undefined) return asks ? ['the spec asks for a documentation page, so deploy.docsPath must name it (for example /docs)'] : [];
  if (!asks) return ['deploy.docsPath is declared, but the spec asks for no documentation page; remove it'];
  const built = tasks.some((t) => {
    const text = [t.title, t.description, ...t.affectedPaths].join(' ').toLowerCase();
    return text.includes(docsPath.toLowerCase()) || /swagger|openapi/.test(text);
  });
  return built ? [] : [`deploy.docsPath ${docsPath} is declared, but no task builds the documentation page at ${docsPath}`];
}
