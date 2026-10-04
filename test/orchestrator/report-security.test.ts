import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { securityFindings } from '../../server/orchestrator/phases/report.js';

const f = (severity: string, problem: string) => ({ file: 'src/a.ts', line: 3, severity, category: 'injection', problem, fix: 'fix it' });
const ev = (type: string, taskId: string, findings: unknown[]) => ({ type, data: { taskId, findings } });

describe('securityFindings', () => {
  it('keeps only the latest review of each task and sorts by severity', () => {
    const out = securityFindings([
      ev(OrchEvent.SecurityChanges, 'T1', [f('high', 'old attempt')]),
      ev(OrchEvent.SecurityApproved, 'T1', [f('low', 'verbose log')]),
      ev(OrchEvent.SecurityApproved, 'T2', [f('medium', 'open cors'), f('critical', 'hardcoded token')]),
      { type: OrchEvent.ReviewApproved, data: { taskId: 'T1', findings: [f('critical', 'not a security event')] } },
    ]);
    expect(out.map((x) => [x.taskId, x.severity, x.problem])).toEqual([
      ['T2', 'critical', 'hardcoded token'],
      ['T2', 'medium', 'open cors'],
      ['T1', 'low', 'verbose log'],
    ]);
  });

  it('is empty when no task had a security review', () => {
    expect(securityFindings([])).toEqual([]);
  });
});
