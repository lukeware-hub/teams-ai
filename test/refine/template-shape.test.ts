import { describe, expect, it } from 'vitest';
import { briefTemplate, designTemplate, projectTemplate, stackTemplate } from '../../server/refine/draft.js';
import { isUntouched, shapeProblem } from '../../server/refine/template-shape.js';
import { LOOSE_BRIEF, SHAPED_BRIEF } from '../fixtures/briefing-shape.js';

const DECISION = '## Decisões\n\n### Porta\n\n> A API responde na porta 8080.\n';

describe('shapeProblem', () => {
  it('accepts a text with the template headings in order and no placeholder left', () => {
    expect(shapeProblem('briefing.md', SHAPED_BRIEF, SHAPED_BRIEF, 'shop')).toBeNull();
  });

  it('refuses a heading the template lacks', () => {
    expect(shapeProblem('briefing.md', LOOSE_BRIEF, SHAPED_BRIEF, 'shop')).toMatch(/seções não seguem o modelo, na mesma ordem/);
  });

  it('refuses the template headings out of their order', () => {
    const swapped = SHAPED_BRIEF.replace('## Type\n\nfeature\n\n## Objectives\n\n- Vender online.\n\n', '## Objectives\n\n- Vender online.\n\n## Type\n\nfeature\n\n');
    expect(shapeProblem('briefing.md', swapped, SHAPED_BRIEF, 'shop')).toMatch(/seções não seguem o modelo/);
  });

  it('refuses a placeholder of the template left in the text', () => {
    const left = SHAPED_BRIEF.replace('- (none)', '- <item>');
    expect(shapeProblem('briefing.md', left, SHAPED_BRIEF, 'shop')).toMatch(/texto do modelo: <item>/);
  });

  it('refuses an empty text', () => {
    expect(shapeProblem('stack.md', ' \n', stackTemplate(), 'shop')).toMatch(/vazio/);
  });

  it('ignores the title, which holds the name of the project', () => {
    const project = '# Loja online\n\n## Vision\n\nVender roupas pela internet.\n\n## Personas\n\n- Cliente: compra roupas.\n\n## Constraints\n\n- (none)\n\n## Stack\n\n- (none)\n\n## Principles\n\n- (none)\n\n## Deploy target\n\ndocker-local\n\n## GitHub owner\n\n- (none)\n';
    expect(shapeProblem('project.md', project, project, 'shop')).toBeNull();
  });

  it('keeps a recorded decision word for word', () => {
    const before = `${SHAPED_BRIEF}\n${DECISION}`;
    expect(shapeProblem('briefing.md', before, before, 'shop')).toBeNull();
    expect(shapeProblem('briefing.md', before.replace('porta 8080', 'porta 9090'), before, 'shop')).toMatch(/decisões já registradas/);
  });

  it('compares the subsections of a design too', () => {
    const design = designTemplate().replace('### Typography', '### Tipografia');
    expect(shapeProblem('design.md', design, design, 'shop')).toMatch(/seções não seguem o modelo/);
  });
});

describe('isUntouched', () => {
  it('is true for a blank file and for a file with only lines of the template', () => {
    expect(isUntouched('stack.md', '', 'shop')).toBe(true);
    expect(isUntouched('stack.md', stackTemplate(), 'shop')).toBe(true);
    expect(isUntouched('briefing.md', briefTemplate(), 'shop')).toBe(true);
  });

  it('is true when only the title of the project differs from the template', () => {
    expect(isUntouched('project.md', projectTemplate('Shop').replace('# Shop', '# Loja'), 'shop')).toBe(true);
  });

  it('is false once a line is not in the template', () => {
    expect(isUntouched('briefing.md', LOOSE_BRIEF, 'shop')).toBe(false);
  });
});
