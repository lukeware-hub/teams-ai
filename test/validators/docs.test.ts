import { describe, expect, it } from 'vitest';
import { featureEndpoints, validateApiDocs, validateDocs, validateReadme, validateRunbook } from '../../server/validators/docs.js';

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
});

describe('validateDocs', () => {
  it('combines the three files', () => {
    expect(validateDocs({ readme: GOOD_README, runbook: GOOD_RUNBOOK, apiDocs: '/health' }, ['GET /health'])).toEqual([]);
    expect(validateDocs({ readme: GOOD_README, runbook: undefined, apiDocs: null }, ['GET /health']).length).toBeGreaterThan(1);
  });
});
