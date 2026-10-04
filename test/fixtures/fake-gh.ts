import { execCommand } from '../../server/exec/command.js';
import type { FakeExec } from './fake-exec.js';

export interface FakePr {
  number: number;
  head: string;
  base: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid: string;
  title: string;
  body: string;
}

/** In-memory GitHub: enough of `gh pr` for ensurePr / findMergedPr / prState / mergePr. */
export class FakeGh {
  readonly prs: FakePr[] = [];
  nextNumber = 1;

  install(exec: FakeExec): this {
    exec.on((s) => s.bin === 'gh' && s.args[0] === 'pr', async (s) => {
      const arg = (flag: string) => s.args[s.args.indexOf(flag) + 1]!;
      switch (s.args[1]) {
        case 'list': {
          const state = arg('--state');
          const rows = this.prs.filter((p) => p.head === arg('--head') && p.base === arg('--base') && (state === 'all' || p.state === state.toUpperCase()));
          return { stdout: JSON.stringify(rows.map((p) => ({ number: p.number, url: `https://github.example/o/r/pull/${p.number}`, state: p.state, headRefOid: p.headRefOid }))) };
        }
        case 'create': {
          const head = arg('--head');
          const sha = (await execCommand({ bin: 'git', args: ['rev-parse', head], cwd: s.cwd, timeoutMs: 10_000 })).stdout.trim();
          const pr: FakePr = { number: this.nextNumber++, head, base: arg('--base'), state: 'OPEN', headRefOid: sha, title: arg('--title'), body: s.stdin ?? '' };
          this.prs.push(pr);
          return { stdout: `https://github.example/o/r/pull/${pr.number}\n` };
        }
        case 'view': {
          const pr = this.prs.find((p) => p.number === Number(s.args[2]));
          return pr ? { stdout: JSON.stringify({ state: pr.state, headRefOid: pr.headRefOid }) } : { exitCode: 1, stderr: 'not found' };
        }
        case 'merge': {
          const pr = this.prs.find((p) => p.number === Number(s.args[2]));
          if (!pr) return { exitCode: 1, stderr: 'not found' };
          if (pr.state === 'MERGED') return { exitCode: 1, stderr: 'Pull request is already merged' };
          const wanted = arg('--match-head-commit');
          const current = (await execCommand({ bin: 'git', args: ['rev-parse', pr.head], cwd: s.cwd, timeoutMs: 10_000 })).stdout.trim();
          if (wanted !== current) return { exitCode: 1, stderr: 'head commit changed' };
          pr.state = 'MERGED';
          pr.headRefOid = current;
          // Squash-merge into main on the remote, as GitHub would.
          await execCommand({ bin: 'git', args: ['push', 'origin', `${pr.head}:${pr.base}`], cwd: s.cwd, timeoutMs: 10_000 });
          return { stdout: '' };
        }
        default:
          return { exitCode: 1, stderr: `fake gh: unsupported ${s.args.join(' ')}` };
      }
    });
    return this;
  }
}
