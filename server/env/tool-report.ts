import { z } from 'zod';

export const ToolReport = z.object({
  host: z.object({
    kernel: z.string(),
    distro: z.string(),
    onLinuxFs: z.boolean(),
  }),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      present: z.boolean(),
      version: z.string().nullable(),
    }),
  ),
});
export type ToolReport = z.infer<typeof ToolReport>;

/** Floors come from the spec (§15) and Plan 1's pins. `llama-server` is only needed for Plan 8. */
export const REQUIRED_TOOLS: ReadonlyArray<{ name: string; minVersion?: string; optional?: boolean }> = [
  { name: 'node', minVersion: '22.12.0' },
  { name: 'npm' },
  { name: 'git' },
  { name: 'claude', minVersion: '2.1.0' },
  { name: 'gh' },
  { name: 'docker' },
  { name: 'gitleaks' },
  { name: 'osv-scanner' },
  { name: 'graphify' },
  { name: 'nvidia-smi', optional: true },
  { name: 'llama-server', optional: true },
];

export type ToolStatus = 'OK' | 'MISSING' | 'OPTIONAL-MISSING' | 'NOT-ON-LINUX-FS';

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function evaluateReport(report: ToolReport): Array<{ name: string; status: ToolStatus; detail: string }> {
  const rows: Array<{ name: string; status: ToolStatus; detail: string }> = [];
  rows.push(
    report.host.onLinuxFs
      ? { name: 'filesystem', status: 'OK', detail: 'repository on the Linux filesystem' }
      : { name: 'filesystem', status: 'NOT-ON-LINUX-FS', detail: 'move teams-ai and ~/.teams-ai off /mnt/c (spec §15)' },
  );
  const found = new Map(report.tools.map((t) => [t.name, t]));
  for (const tool of REQUIRED_TOOLS) {
    const entry = found.get(tool.name);
    const missing: ToolStatus = tool.optional ? 'OPTIONAL-MISSING' : 'MISSING';
    if (!entry || !entry.present) {
      rows.push({ name: tool.name, status: missing, detail: 'not installed' });
      continue;
    }
    if (tool.minVersion && (entry.version === null || compareVersions(entry.version, tool.minVersion) < 0)) {
      rows.push({ name: tool.name, status: missing, detail: `found ${entry.version ?? 'unknown'}, need >=${tool.minVersion}` });
      continue;
    }
    rows.push({ name: tool.name, status: 'OK', detail: entry.version ?? 'present' });
  }
  return rows;
}
