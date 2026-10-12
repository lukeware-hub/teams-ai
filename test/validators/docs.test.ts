import { describe, expect, it } from 'vitest';
import { featureEndpoints, missingReadmeSections, validateApiDocs, validateDocs, validateReadme, validateRunbook } from '../../server/validators/docs.js';

const body = 'Some real explanatory text that is long enough to count.';
const md = (...titles: string[]) => titles.map((t) => `## ${t}\n\n${body}\n`).join('\n');
export const GOOD_README = `# Shop\n\n${md('Run', 'Test', 'Environment variables', 'Architecture', 'Pipeline')}`;
export const GOOD_RUNBOOK = `# Runbook\n\n${md('Start', 'Stop', 'Logs', 'Rollback')}`;

describe('validateReadme', () => {
  it('accepts the five sections', () => expect(validateReadme(GOOD_README)).toEqual([]));
  it('accepts Portuguese names and any case', () => {
    expect(validateReadme(md('COMO RODAR', 'Testes', 'Variáveis de ambiente', 'Arquitetura', 'pipeline'))).toEqual([]);
  });
  it('names each missing section', () => {
    const errors = validateReadme(md('Run', 'Test'));
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/"env"[\s\S]*"architecture"[\s\S]*"pipeline"/);
  });
  it('rejects a heading with an empty body', () => {
    expect(validateReadme(`${md('Run', 'Test', 'Env', 'Pipeline')}\n## Architecture\n\ntodo\n`)).toEqual([expect.stringContaining('"architecture" has no content')]);
  });
  it('ignores headings inside code fences', () => {
    expect(validateReadme(`\`\`\`\n## Run\n\`\`\`\n${md('Test', 'Env', 'Architecture', 'Pipeline')}`)).toEqual([expect.stringContaining('"run"')]);
  });
  it('rejects an empty file', () => expect(validateReadme('  ')).toEqual(['docs/README.md is empty']));
});

describe('validateRunbook', () => {
  it('accepts start, stop, logs, rollback', () => expect(validateRunbook(GOOD_RUNBOOK)).toEqual([]));
  it('flags missing headings', () => expect(validateRunbook(md('Start', 'Logs'))).toHaveLength(2));
});

describe('validateApiDocs', () => {
  const features = ['GET /health returns ok', 'POST /api/items creates an item', 'sums numbers'];
  it('extracts endpoint paths from features', () => expect(featureEndpoints(features)).toEqual(['/health', '/api/items']));
  it('requires every endpoint', () => {
    expect(validateApiDocs('GET /health', features)).toEqual(['docs/API.md does not document endpoint /api/items']);
    expect(validateApiDocs('GET /health\nPOST /api/items', features)).toEqual([]);
  });
  it('is not required when no endpoint is named', () => expect(validateApiDocs(null, ['sums numbers'])).toEqual([]));
  it('requires the file when endpoints exist', () => expect(validateApiDocs(null, features)).toHaveLength(1));
  it('keeps every endpoint the current docs/API.md documents, since earlier specs wrote it', () => {
    const current = '# API\n\n### POST /stock\n\n### GET /stock/{sku}\n';
    expect(validateApiDocs('### POST /orders', ['POST /orders creates an order'], current)).toEqual([
      'docs/API.md dropped endpoint /stock, which it documented before; keep it, or mark it as removed if this spec removed it',
      'docs/API.md dropped endpoint /stock/{sku}, which it documented before; keep it, or mark it as removed if this spec removed it',
    ]);
    expect(validateApiDocs(`${current}\n### POST /orders`, ['POST /orders creates an order'], current)).toEqual([]);
  });
  it('accepts an endpoint the rewrite marks as removed', () => {
    expect(validateApiDocs('### POST /orders\n\n`/stock` was removed by this spec.', [], '### POST /stock')).toEqual([]);
  });
  it('lets an empty answer through, since it leaves the current file in place', () => {
    expect(validateApiDocs('', ['sums numbers'], '### POST /stock')).toEqual([]);
  });
});

describe('validateDocs', () => {
  it('combines the three files', () => {
    expect(validateDocs({ readme: GOOD_README, runbook: GOOD_RUNBOOK, apiDocs: '/health' }, ['GET /health'])).toEqual([]);
    expect(validateDocs({ readme: GOOD_README, runbook: undefined, apiDocs: null }, ['GET /health']).length).toBeGreaterThan(1);
  });
  it('checks the API answer against the docs/API.md it replaces', () => {
    expect(validateDocs({ readme: GOOD_README, runbook: GOOD_RUNBOOK, apiDocs: '/health' }, ['GET /health'], [], { readme: '', runbook: '', apiDocs: '### GET /stock' })).toEqual([
      'docs/API.md dropped endpoint /stock, which it documented before; keep it, or mark it as removed if this spec removed it',
    ]);
  });
  it('also requires every other section the plan lists, so the README passes the next verification', () => {
    expect(validateDocs({ readme: GOOD_README, runbook: GOOD_RUNBOOK, apiDocs: '/health' }, ['GET /health'], ['Environment', 'Monitoring'])).toEqual([
      'docs/README.md is missing a "Monitoring" section the plan requires (add a heading naming it)',
    ]);
  });
});

describe('missingReadmeSections', () => {
  it('accepts the usual names of the standard sections, the same ones the README validator accepts', () => {
    const readme = md('Executar (run)', 'Testar (test)', 'Variáveis de ambiente (env)', 'Arquitetura', 'Pipeline (CI/CD)');
    expect(missingReadmeSections(readme, ['Run', 'Test', 'Environment', 'Architecture', 'Pipeline'])).toEqual([]);
  });
  it('names each planned section no heading carries; any other section is matched by its own word', () => {
    expect(missingReadmeSections(md('Run', 'Security notes'), ['Run', 'Test', 'Security', 'Monitoring'])).toEqual(['Test', 'Monitoring']);
  });
});
