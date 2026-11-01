import { describe, expect, it } from 'vitest';
import { planShapeIssues } from '../../server/refine/plan-shape.js';
import { taskShapeIssues } from '../../server/refine/task-shape.js';
import { taskPack } from '../../server/refine/superpowers-pack.js';

const CRITERIA = ['AC-001', 'AC-002'];

const PLAN = [
  '# Shop plan',
  '',
  '**Goal:** Sell.',
  '**Architecture:** Two services.',
  '**Tech Stack:** Node.',
  '**Spec:** docs/specs/shop-001/spec.md',
  '**Repository:** shop-api',
  '',
  '## Global Constraints',
  '',
  'None.',
  '',
  '## Review Focus',
  '',
  'Cart.',
  '',
  '## Assumptions',
  '',
  '- None.',
  '',
  '### Task 1: Cart',
  '',
  '**Files:** - Create: `src/cart.ts`',
  '**Criteria:** AC-001',
  '',
  '### Task 2: Pay',
  '',
  '**Files:** - Modify: `src/pay.ts`',
  '**Criteria:** AC-002',
  '',
].join('\n');

const entry = (n: number, name: string, criteria: string, repository = 'shop-api') =>
  [
    `## Task ${n}: ${name}`,
    '',
    '**Spec:** docs/specs/shop-001/spec.md',
    '**Plan:** docs/specs/shop-001/implementation-plan.md',
    `**Repository:** ${repository}`,
    `**Objective:** ${name} do carrinho.`,
    `**Criteria:** ${criteria}`,
    '**Success scenario:** Um item entra no carrinho.',
    '**Error scenario:** Quantidade zero é recusada.',
    '**Done when:** O carrinho mostra o item.',
    '',
  ].join('\n');

const TASKS = ['# Shop tasks', '', entry(1, 'Cart', 'AC-001'), entry(2, 'Pay', 'AC-002')].join('\n');

describe('plan header of a stamped draft', () => {
  it('names the repository in the header line', () => {
    expect(planShapeIssues(PLAN, CRITERIA, 'shop-api')).toEqual([]);
    expect(planShapeIssues(PLAN, CRITERIA, 'shop-web')).toContain('the header has no **Repository:** shop-web line');
  });

  it('asks nothing of a plan of a draft with no repository', () => {
    expect(planShapeIssues(PLAN, CRITERIA)).toEqual([]);
  });
});

describe('task list shape', () => {
  it('accepts one entry per plan task, citing the criteria the plan task delivers', () => {
    expect(taskShapeIssues(TASKS, PLAN, CRITERIA, 'shop-api')).toEqual([]);
  });

  it('names a plan task with no entry, and an entry the plan does not have', () => {
    expect(taskShapeIssues(TASKS.replace(entry(2, 'Pay', 'AC-002'), entry(3, 'Pay', 'AC-002')), PLAN, CRITERIA, 'shop-api')).toEqual(
      expect.arrayContaining(['plan task 2 has no "## Task 2:" entry', 'task.md has entry 3, which the plan does not have']),
    );
  });

  it('refuses an entry whose criteria differ from its plan task', () => {
    const issues = taskShapeIssues(TASKS.replace('**Criteria:** AC-002', '**Criteria:** AC-001, AC-002'), PLAN, CRITERIA, 'shop-api');
    expect(issues).toContain('Task 2 lists criteria AC-001, AC-002, but its plan task delivers AC-002');
  });

  it('refuses a criterion that no entry proves, and one the spec does not have', () => {
    const uncovered = taskShapeIssues(TASKS.replace('**Criteria:** AC-002', '**Criteria:** AC-001'), PLAN, CRITERIA, 'shop-api');
    expect(uncovered).toContain('criterion AC-002 is in no task entry');
    const unknown = taskShapeIssues(TASKS.replace('**Criteria:** AC-002', '**Criteria:** AC-009'), PLAN, CRITERIA, 'shop-api');
    expect(unknown).toContain('criterion AC-009 is not in the spec');
  });

  it('requires the success and the error scenario, and the repository of the spec', () => {
    const noError = TASKS.replace('**Error scenario:** Quantidade zero é recusada.\n', '');
    expect(taskShapeIssues(noError, PLAN, CRITERIA, 'shop-api')).toContain('Task 1 has no **Error scenario:** line');
    expect(taskShapeIssues(TASKS.replace(/\*\*Repository:\*\* shop-api/g, '**Repository:** shop-web'), PLAN, CRITERIA, 'shop-api')).toContain(
      'Task 1 names another repository than shop-api',
    );
  });

  it('refuses placeholder text', () => {
    expect(taskShapeIssues(TASKS.replace('O carrinho mostra o item.', 'TODO'), PLAN, CRITERIA, 'shop-api').join(' ')).toContain('placeholder text');
  });
});

describe('task pack', () => {
  it('carries the graph context about the spec when the graph has something', () => {
    const pack = taskPack({ specHash: 'h', inputDir: 'speckit-input', specId: 'shop-001', key: 'cart', title: 'Carrinho', criteria: CRITERIA, graphContext: 'Nó: shop-api' });
    expect(pack.feedback).toContain('### Graph context\nNó: shop-api');
    expect(taskPack({ specHash: 'h', inputDir: 'speckit-input', specId: 'shop-001', key: 'cart', title: 'Carrinho', criteria: CRITERIA }).feedback).not.toContain('Graph context');
  });

  it('asks for one entry per plan task, with the repository it changes', () => {
    const pack = taskPack({
      specHash: 'h',
      inputDir: 'speckit-input',
      specId: 'shop-001',
      key: 'cart',
      title: 'Carrinho',
      criteria: CRITERIA,
      repository: { name: 'shop-api', kind: 'api', responsibility: 'Vende', integrations: ['shop-web → shop-api: GET /cart'] },
    });
    expect(pack).toMatchObject({ kind: 'speckit', role: 'test' });
    expect(pack.feedback).toContain('docs/specs/shop-001/task.md');
    expect(pack.feedback).toContain('**Repository:** (shop-api)');
    expect(pack.feedback).toContain('The spec changes the repository shop-api (api): Vende. Its integrations: shop-web → shop-api: GET /cart.');
  });
});
