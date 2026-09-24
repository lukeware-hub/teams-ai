import { describe, expect, it } from 'vitest';
import { REQUIRED_TOOLS, ToolReport, compareVersions, evaluateReport } from '../../server/env/tool-report.js';

const report = (tools: Array<{ name: string; present: boolean; version: string | null }>, onLinuxFs = true) =>
  ToolReport.parse({ host: { kernel: '5.15.167.4-microsoft-standard-WSL2', distro: 'Ubuntu-24.04', onLinuxFs }, tools });

describe('compareVersions', () => {
  it('orders numeric components and ignores a v prefix', () => {
    expect(compareVersions('v22.12.0', '22.11.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0);
    expect(compareVersions('0.9.34', '0.10.0')).toBeLessThan(0);
  });
});

describe('evaluateReport', () => {
  it('marks a present tool at or above its floor as OK', () => {
    const rows = evaluateReport(report([{ name: 'node', present: true, version: 'v22.12.0' }]));
    expect(rows.find((r) => r.name === 'node')).toMatchObject({ status: 'OK' });
  });

  it('marks a present tool below its floor as MISSING with the floor in the detail', () => {
    const rows = evaluateReport(report([{ name: 'node', present: true, version: 'v20.19.0' }]));
    expect(rows.find((r) => r.name === 'node')).toMatchObject({ status: 'MISSING', detail: expect.stringContaining('>=22.12') });
  });

  it('marks absent required tools MISSING and absent optional tools OPTIONAL-MISSING', () => {
    const rows = evaluateReport(report([]));
    expect(rows.find((r) => r.name === 'claude')!.status).toBe('MISSING');
    expect(rows.find((r) => r.name === 'llama-server')!.status).toBe('OPTIONAL-MISSING');
  });

  it('flags a repository that lives under /mnt/c', () => {
    const rows = evaluateReport(report([], false));
    expect(rows[0]).toMatchObject({ name: 'filesystem', status: 'NOT-ON-LINUX-FS' });
  });

  it('lists every required tool exactly once', () => {
    const names = evaluateReport(report([])).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of REQUIRED_TOOLS) expect(names).toContain(tool.name);
  });
});
