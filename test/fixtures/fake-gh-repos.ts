import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execCommand, type CommandResult, type Exec } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';

export interface FakeRepo {
  /** The bare origin on disk; its url is this path without the .git suffix. */
  origin: string;
  isPrivate: boolean;
  archived: boolean;
  viewerPermission: string;
}

const result = (partial: Partial<CommandResult>): CommandResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  durationMs: 1,
  truncated: false,
  ...partial,
});

/**
 * A stand-in for GitHub's `gh repo view` and `gh repo create`. Repositories are bare origins in a temp folder, so tests
 * never reach GitHub. Every other command runs for real.
 */
export class FakeGhRepos {
  readonly repos = new Map<string, FakeRepo>();
  readonly creates: string[] = [];

  constructor(private readonly root: string) {}

  readonly exec: Exec = async (spec) => {
    if (spec.bin !== 'gh' || spec.args[0] !== 'repo') return execCommand(spec);
    const fullName = spec.args[2]!;
    return spec.args[1] === 'view' ? this.view(fullName) : this.create(fullName);
  };

  /** Adds a repository that already exists: an empty bare origin, or one that carries history. */
  register(fullName: string, origin: string, opts: Partial<Omit<FakeRepo, 'origin'>> = {}): void {
    this.repos.set(fullName, { origin, isPrivate: true, archived: false, viewerPermission: 'ADMIN', ...opts });
  }

  private async view(fullName: string): Promise<CommandResult> {
    const repo = this.repos.get(fullName);
    if (!repo) return result({ exitCode: 1, stderr: `GraphQL: Could not resolve to a Repository with the name '${fullName}'.` });
    const isEmpty = (await git(repo.origin, ['for-each-ref', 'refs/heads'])) === '';
    return result({
      stdout: JSON.stringify({
        nameWithOwner: fullName,
        url: repo.origin.replace(/\.git$/, ''),
        isPrivate: repo.isPrivate,
        isArchived: repo.archived,
        isEmpty,
        viewerPermission: repo.viewerPermission,
        defaultBranchRef: isEmpty ? null : { name: 'main' },
      }),
    });
  }

  private async create(fullName: string): Promise<CommandResult> {
    if (this.repos.has(fullName)) return result({ exitCode: 1, stderr: `${fullName} already exists` });
    const origin = path.join(this.root, `${fullName.replace('/', '-')}.git`);
    await fs.mkdir(origin, { recursive: true });
    await git(origin, ['init', '--bare', '-b', 'main']);
    this.register(fullName, origin);
    this.creates.push(fullName);
    return result({ stdout: `https://github.example/${fullName}\n` });
  }
}
