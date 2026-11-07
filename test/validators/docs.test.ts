import { describe, expect, it } from 'vitest';
import { documentedEndpoints, featureEndpoints, missingReadmeSections } from '../../server/validators/docs.js';

const body = 'Some real explanatory text that is long enough to count.';
const md = (...titles: string[]) => titles.map((t) => `## ${t}\n\n${body}\n`).join('\n');

describe('featureEndpoints', () => {
  it('extracts endpoint paths from features', () => {
    expect(featureEndpoints(['GET /health returns ok', 'POST /api/items creates an item', 'sums numbers'])).toEqual(['/health', '/api/items']);
  });
});

describe('documentedEndpoints', () => {
  it('reads the endpoints of a document after their methods and outside code blocks', () => {
    const current = ['# API', '', '| Método | Rota |', '|DELETE|/stock/{sku}/reservas|', '', '**GET**/legacy', '', '```', 'curl -X POST /app/data/pedidos.json', '```', '', 'Os logs ficam em /var/log/loja.log.'].join('\n');
    expect(documentedEndpoints(current)).toEqual(['/stock/{sku}/reservas', '/legacy']);
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
