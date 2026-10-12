# Plan 82 - Prebuilt image in GHCR (R9.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `task up` and `task start` pull a prebuilt image from the GitHub container registry instead of building, so the first start is a download; a developer working from source still builds locally with one command.

**Architecture:** the CI workflow gets a `publish` job that runs after `quality` on a push to `main` or a `v*` tag. It builds the one `Dockerfile` for `linux/amd64` and `linux/arm64`, pushes it under the full commit sha only, scans that image for critical vulnerabilities, and only then points `latest` (or the version, on a tag) at it. `docker-compose.yml` keeps `build: .` and names the image `${TEAMS_AI_IMAGE:-ghcr.io/diego-dm-morais/teams-ai:latest}` for both services that use it. `task up` and `task start` run `docker compose pull --ignore-pull-failures` and then `up` without `--build`: a pulled image is used as it is, and when the pull fails (image missing, package private and not logged in, no network) compose builds the same tag from source. A new `task up:source` sets `TEAMS_AI_IMAGE=teams-ai:local` and builds, so source edits never run an older pulled image.

**Tech Stack:** GitHub Actions (`docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`, the `aquasec/trivy` image at the version the repo already pins), Docker Compose v2, Taskfile, vitest, YAML.

**Spec:** roadmap R9.4 (`docs/superpowers/ROADMAP.md`, "R9.4 Prebuilt image in GHCR"): "`task up` would pull instead of building (first start drops from minutes to a download). Needs a publish workflow, a decision on package visibility and a change to `docker-compose.yml` that keeps `test/infra/compose.test.ts` true."

## Facts this plan rests on (read from the repo on 2026-10-12)

- `docker-compose.yml:7-8` and `:43-44`: `teams-ai` and `goproxy` both have `build: .` and `image: teams-ai:local`; `test/infra/compose.test.ts` asserts nothing about `build` or `image`, only `dind.image`, ports, volumes, `cap_drop`, `DOCKER_HOST` and `depends_on`, so changing the two `image:` lines keeps it true.
- `Taskfile.yml:19-23` (`up`) runs `docker compose up -d --build`; `Taskfile.yml:55-59` (`start`) runs `docker compose up -d --build --wait`. `--build` always rebuilds, so it must leave both.
- `.github/workflows/ci.yml:3-9`: triggers are `push` to `main` and `pull_request`; the workflow-level permission is `contents: read`. No image is published anywhere. The old name `ghcr.io/diego-dm-morais/teams-ai` never existed in the history: `git log -S"ghcr.io"` only finds the generator for other people's repositories (`server/orchestrator/workflows.ts:101-116`, the model for the publish steps here).
- Verified on this machine with a copy of the compose file in a scratch folder: `docker compose config` accepts the new `image:` value; `docker compose pull --ignore-pull-failures` exits 0 when the image does not exist and warns "must be built from source"; `docker compose up -d --dry-run` with an image that is not local tries the pull, fails, then prints `Building`. So the fallback is compose's own behavior and needs no script.
- Secrets: `Dockerfile:36` is `COPY . .`; `.dockerignore` excludes `.env*`, `config.json` (the root one), `.git`, `node_modules`, `coverage`, `*.log`; the Dockerfile has no `ARG` and no `ENV` with a token, secret or key; the seed `docker/config.json` has `"projects": []` and no token. Tokens only enter at run time through `docker-compose.yml:20-30`. The image does carry the whole tracked source and `docs/`.
- The repository `diego-dm-morais/teams-ai` is **private** (`gh repo view`), the local image is 4.44 GB, `uname -m` is `arm64` (the owner's Mac), and every base image (`node:22-bookworm`, `docker:27-cli`, `golang:1.26-bookworm`, `rust:1-bookworm`, `docker:27-dind-rootless`) has an `arm64` manifest.

## Decision for the human: package visibility

The image contains the whole source tree and the docs (`Dockerfile:36`), and the repository is private.

| Option | Consequence | Cost per user |
| --- | --- | --- |
| **A. Private package (recommended)** | The package is linked to the private repository by the `org.opencontainers.image.source` label and inherits its access: only people with access to the repository can pull. The source stays private. | Every machine runs once `docker login ghcr.io` with a classic token that has `read:packages` (GHCR does not accept fine-grained tokens). Without it the pull fails and compose silently falls back to the slow local build. |
| **B. Public package** | No login anywhere, the fastest onboarding for Windows users. Anyone on the internet can `docker pull` the image and read every file of the source and the docs. Made public by hand in the package settings; GitHub does not allow going back to private once the package has many downloads. | None. |

Recommendation: A. The people who run Teams AI already clone the private repository (README step "na pasta do projeto"), so they already have access; the extra step is one command, and nothing leaks. Choose B only if the repository itself is going public, or after the source is taken out of the image (a larger change, not in this plan). The README written in Task 4 assumes A; if the owner picks B, delete its login paragraph.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- What the owner reads is in Brazilian Portuguese.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`), never a bare `git commit`, and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `task start` on a machine with no local image and a reachable public image: no build runs, only a pull; with the pull failing, it builds and still starts.
2. `task up:source` never uses a pulled image: it sets `TEAMS_AI_IMAGE=teams-ai:local` and passes `--build`.
3. `latest` and the version tag are written only after the scan passes; a failed scan leaves only the commit-sha tag, which no user pulls.
4. The `publish` job is the only place with `packages: write`; it never runs on `pull_request`, so a fork's pull request cannot push or use the token.
5. The image carries no token: `.dockerignore` keeps `.env*` and `config.json` out, and the Dockerfile has no secret `ARG` or `ENV`.

## Limits

- Only the `linux/amd64` image is scanned; the `linux/arm64` one comes from the same `Dockerfile` and the same package versions.
- The `arm64` build runs under emulation on a GitHub runner, so a publish takes tens of minutes; the job allows 90.
- The scan blocks only fixable `CRITICAL` findings (`--ignore-unfixed`); a new one in the base image stops publishing until the base is bumped.
- `latest` moves on every push to `main`; users who need a fixed version set `TEAMS_AI_IMAGE` in `.env` to a version tag or a full sha.
- A user who is not logged in to a private package gets the local build with no error, only compose's "must be built from source" warning.
- Making the package public, if chosen, is a manual step in the GitHub package settings; it has no API for user accounts.

---

### Task 1: Compose names the registry image; `up` and `start` pull it

**Files:**
- Modify: `docker-compose.yml` (the two `image:` lines and a comment)
- Modify: `Taskfile.yml` (`up`, `start`, new `pull`, new `up:source`)
- Test: `test/infra/compose.test.ts`, `test/infra/publish.test.ts` (new)

**Interfaces:**
- Produces: the image reference `${TEAMS_AI_IMAGE:-ghcr.io/diego-dm-morais/teams-ai:latest}` that Task 2 publishes; the internal task `pull`.

- [ ] **Step 1: Write the failing tests**

In `test/infra/compose.test.ts`, add inside `describe('docker-compose.yml (audit H4)')`, after the test `'seeds a config that reaches the service through dind without a bind rewrite'`:

```ts
  it('runs the registry image, and builds the same tag from source when it cannot be pulled', () => {
    for (const svc of [platform, compose.services.goproxy]) {
      expect(svc.image).toBe('${TEAMS_AI_IMAGE:-ghcr.io/diego-dm-morais/teams-ai:latest}');
      expect(svc.build).toBe('.');
    }
  });
```

Create `test/infra/publish.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const read = (file: string) => fs.readFile(file, 'utf8');
const taskfile = YAML.parse(await read('Taskfile.yml')) as { tasks: Record<string, any> };

describe('Taskfile.yml (R9.4)', () => {
  it('pulls the prebuilt image before `up` and `start`, and never forces a build', () => {
    expect(taskfile.tasks.pull.cmds).toEqual(['docker compose pull --ignore-pull-failures']);
    for (const name of ['up', 'start']) {
      const cmds = JSON.stringify(taskfile.tasks[name].cmds);
      expect(cmds, name).toContain('"task":"pull"');
      expect(cmds, name).not.toContain('--build');
    }
  });

  it('builds from source under the local tag with `up:source`', () => {
    expect(taskfile.tasks['up:source'].env).toEqual({ TEAMS_AI_IMAGE: 'teams-ai:local' });
    expect(taskfile.tasks['up:source'].cmds).toEqual(['docker compose up -d --build']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/infra`
Expected: FAIL. `svc.image` is `teams-ai:local`, `taskfile.tasks.pull` is undefined, and `up`/`start` still contain `--build`.

- [ ] **Step 3: Implement**

Point both services at the registry image (this exact substitution was run on a copy and `docker compose config` printed `image: ghcr.io/diego-dm-morais/teams-ai:latest` for both):

```bash
sed -i '' 's#image: teams-ai:local#image: ${TEAMS_AI_IMAGE:-ghcr.io/diego-dm-morais/teams-ai:latest}#' docker-compose.yml
```

In `docker-compose.yml`, replace

```yaml
  teams-ai:
    build: .
```

with

```yaml
  teams-ai:
    # The registry image; when it cannot be pulled, `docker compose up` builds this tag from source.
    build: .
```

In `Taskfile.yml`, replace the `up` task (lines 19-23) with:

```yaml
  pull:
    internal: true
    cmds:
      - docker compose pull --ignore-pull-failures

  up:
    desc: Pull the prebuilt image (build it when the pull fails) and start the whole platform (UI on http://localhost:8787)
    deps: [setup]
    cmds:
      - task: pull
      - docker compose up -d

  up:source:
    desc: Build the image from the source in this folder and start the platform (for developing Teams AI)
    deps: [setup]
    env:
      TEAMS_AI_IMAGE: teams-ai:local
    cmds:
      - docker compose up -d --build
```

and in `start`, replace `- docker compose up -d --build --wait` with:

```yaml
      - task: pull
      - docker compose up -d --wait
```

- [ ] **Step 4: Run the tests and the real compose to verify they pass**

Run: `npx vitest run test/infra`
Expected: PASS.

Run: `docker compose config -q && TEAMS_AI_IMAGE=teams-ai:local docker compose config | grep "image: teams-ai:local"`
Expected: no error from the first command, two lines `image: teams-ai:local` from the second.

Run: `task --list | grep -E "up|pull"`
Expected: `up` and `up:source` are listed, `pull` is not (it is internal).

- [ ] **Step 5: Commit**

```bash
git add test/infra/publish.test.ts
git commit -m "feat(compose): up and start pull the registry image and build only when the pull fails, up:source builds from source" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- docker-compose.yml Taskfile.yml test/infra/compose.test.ts test/infra/publish.test.ts
```

(`git add` the new test file first: a pathspec commit only takes files git already tracks or that are staged.)

### Task 2: The `publish` job in the CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml` (tag trigger and the `publish` job)
- Test: `test/infra/publish.test.ts`

**Interfaces:**
- Consumes: the image name `ghcr.io/diego-dm-morais/teams-ai` of Task 1 (built here as `ghcr.io/${GITHUB_REPOSITORY,,}`, so a rename of the repository follows by itself).
- Produces: tags `<full sha>` (always), `latest` (push to `main`) and `X.Y.Z` (tag `vX.Y.Z`).

- [ ] **Step 1: Write the failing tests**

Add to `test/infra/publish.test.ts`, after the `taskfile` constant:

```ts
const ci = YAML.parse(await read('.github/workflows/ci.yml')) as { permissions: unknown; on: any; jobs: Record<string, any> };
const publish = ci.jobs.publish ?? { steps: [] };
const stepNames: string[] = publish.steps.map((s: { name: string }) => s.name);
const step = (name: string) => publish.steps.find((s: { name: string }) => s.name === name);
```

and add these tests at the end of the file:

```ts
describe('.github/workflows/ci.yml publish job (R9.4)', () => {
  it('runs only on a push, after quality, and is the only job that can write packages', () => {
    expect(ci.on.push.tags).toEqual(['v*']);
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(publish.needs).toBe('quality');
    expect(publish.if).toBe("github.event_name == 'push'");
    expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(ci.jobs.quality.permissions).toBeUndefined();
  });

  it('builds both platforms, scans, and only then moves latest or the version', () => {
    expect(step('Build and push the commit tag').with.platforms).toBe('linux/amd64,linux/arm64');
    expect(step('Build and push the commit tag').with.tags).toBe('${{ env.IMAGE }}:${{ github.sha }}');
    expect(step('Scan for critical vulnerabilities').run).toContain('--severity CRITICAL --ignore-unfixed --exit-code 1');
    expect(stepNames.indexOf('Build and push the commit tag')).toBeLessThan(stepNames.indexOf('Scan for critical vulnerabilities'));
    expect(stepNames.indexOf('Scan for critical vulnerabilities')).toBeLessThan(stepNames.indexOf('Publish latest, or the version on a v* tag'));
    expect(step('Publish latest, or the version on a v* tag').run).toContain('docker buildx imagetools create');
  });

  it('pins every action by major tag', () => {
    for (const s of publish.steps.filter((x: { uses?: string }) => x.uses)) expect(s.uses, s.name).toMatch(/@v\d+$/);
  });
});

describe('the image carries no secret (R9.4)', () => {
  it('keeps the env files and the user config out of the build context', async () => {
    const ignored = (await read('.dockerignore')).split('\n');
    expect(ignored).toContain('.env*');
    expect(ignored).toContain('config.json');
  });

  it('never bakes a token, secret, password or key through ARG or ENV', async () => {
    expect(await read('Dockerfile')).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|KEY)/im);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/infra/publish.test.ts`
Expected: FAIL on the three `publish job` tests (`ci.on.push.tags` is undefined, there is no `publish` job); the two `no secret` tests already PASS, they guard what exists today.

- [ ] **Step 3: Implement**

In `.github/workflows/ci.yml`, replace

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

with

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
```

and append at the end of the file (after the `Build web UI` step, same indentation as `quality:`):

```yaml

  publish:
    needs: quality
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    permissions:
      contents: read
      packages: write
    env:
      TRIVY_IMAGE: aquasec/trivy:0.75.0
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Name the image in lower case
        run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_ENV"

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push the commit tag
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
          labels: org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}

      - name: Scan for critical vulnerabilities
        run: |
          docker pull "$IMAGE:$GITHUB_SHA"
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$TRIVY_IMAGE" image --severity CRITICAL --ignore-unfixed --exit-code 1 "$IMAGE:$GITHUB_SHA"

      - name: Publish latest, or the version on a v* tag
        run: |
          tag=latest
          [ "$GITHUB_REF_TYPE" = tag ] && tag="${GITHUB_REF_NAME#v}"
          docker buildx imagetools create -t "$IMAGE:$tag" "$IMAGE:$GITHUB_SHA"
```

Notes that were checked: the YAML above parsed with `yaml` 2.9.1 to `on.push = {branches:[main], tags:[v*]}` and the job permissions `{contents:'read', packages:'write'}`; `aquasec/trivy:0.75.0` exists (`docker manifest inspect`) and is the version `server/validators/tools-installer.ts:19-22` already pins; `${GITHUB_REPOSITORY,,}` printed `ghcr.io/diego-dm/teams-ai` for `Diego-DM/Teams-AI` and the tag logic printed `1.2.3` for `v1.2.3` and `latest` for a branch; `org.opencontainers.image.source` is what links the package to the repository, so the package inherits the repository's access.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/infra`
Expected: PASS.

Run: `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 5: Commit**

```bash
git commit -m "ci: publish the multi-platform image to ghcr.io after a scan, latest on main and the version on a v tag" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- .github/workflows/ci.yml test/infra/publish.test.ts
```

### Task 3: First publish, visibility and the real pull (human steps, no commit)

**Files:** none. This task proves the image exists and decides who can pull it; it needs the owner (the visibility decision) and a push to `main`.

- [ ] **Step 1: Merge and watch the first publish**

After Tasks 1 and 2 are on `main`:

Run: `gh run list --workflow ci.yml --limit 1` and then `gh run watch <id>`
Expected: `quality` and `publish` both green; the `Scan` step prints no `CRITICAL` row. If the scan fails on a fixable critical finding, bump the pinned base digest in `Dockerfile:1-2` in a separate plan, do not lower the severity here.

- [ ] **Step 2: Check the tags and the platforms**

Run: `docker buildx imagetools inspect ghcr.io/diego-dm-morais/teams-ai:latest | grep -E "Platform:"` (after `docker login ghcr.io`)
Expected: `linux/amd64` and `linux/arm64`.

- [ ] **Step 3: Apply the owner's visibility decision**

- A (private, recommended): open the package settings (GitHub, the repository page, "Packages", `teams-ai`, "Package settings"), confirm it shows "Private" and is linked to `diego-dm-morais/teams-ai`. Prove an anonymous pull is refused: `docker logout ghcr.io && docker pull ghcr.io/diego-dm-morais/teams-ai:latest` must print `denied` or `unauthorized`.
- B (public): in the same settings, "Change visibility" to Public. Prove it: `docker logout ghcr.io && docker pull ghcr.io/diego-dm-morais/teams-ai:latest` must download.

- [ ] **Step 4: Prove `task start` on a clean machine state**

Run, with Docker running: `docker compose down && docker image rm ghcr.io/diego-dm-morais/teams-ai:latest teams-ai:local; task start`
Expected (A, after `docker login ghcr.io`, or B): no `Building` line, only the pull, then `Teams AI no ar em http://localhost:8787`. Repeat after `docker logout ghcr.io` with A: compose prints the "must be built from source" warning and builds, and the platform still starts.

### Task 4: README and roadmap

**Files:**
- Modify: `README.md` (lines 38, 186-189 and the task table at line 379)
- Modify: `docs/superpowers/ROADMAP.md` (R9.4)
- Modify: `docs/superpowers/plans/README.md` (row 82)

- [ ] **Step 1: Update the README (Brazilian Portuguese)**

Replace line 38, `   <http://localhost:8787>. O primeiro build leva alguns minutos.`, with:

```markdown
   <http://localhost:8787>. Na primeira vez ele baixa a imagem pronta (alguns minutos, conforme a sua internet); se não conseguir baixar, constrói a partir do código, o que leva mais tempo.
```

Replace lines 186-189 (the `task up` block and the sentence after it) with:

```markdown
   task up        # baixa a imagem pronta e sobe; constrói a partir do código se não conseguir baixar
   ```

   A imagem fica no GitHub Container Registry, em um pacote privado. Antes do primeiro `task up`, entre uma vez com um token clássico do GitHub que tenha a permissão `read:packages`:

   ```bash
   echo SEU_TOKEN | docker login ghcr.io -u SEU_USUARIO --password-stdin
   ```

   Sem esse login o download falha e o Docker constrói a imagem no seu computador, o que leva alguns minutos. Para fixar uma versão, coloque `TEAMS_AI_IMAGE=ghcr.io/diego-dm-morais/teams-ai:1.2.3` no `.env`. Para desenvolver o próprio Teams AI, use `task up:source`, que constrói a imagem a partir do código desta pasta.
```

(Keep the opening triple backtick above line 186 as it is; the replacement starts on the line of `task up`.)

Replace the table row at line 379 with two rows:

```markdown
| `task up` | Baixa a imagem pronta (constrói se não conseguir baixar) e inicia a plataforma (cria o `.env` se faltar) |
| `task up:source` | Constrói a imagem a partir do código desta pasta e inicia a plataforma (para desenvolver o Teams AI) |
```

If the owner chose option B, delete the login paragraph and the `echo SEU_TOKEN` block, and change "em um pacote privado" to "em um pacote público".

- [ ] **Step 2: Update the roadmap and the plans index**

In `docs/superpowers/ROADMAP.md`, change `### R9.4 Prebuilt image in GHCR - `todo`` to `### R9.4 Prebuilt image in GHCR - `done` (plan 82, 2026-10-12)` and replace its single bullet with:

```markdown
- Built: the `publish` job of `ci.yml` builds `linux/amd64` and `linux/arm64`, pushes the commit-sha tag, scans for critical fixable vulnerabilities with trivy 0.75.0 and only then moves `latest` (push to `main`) or the version (tag `v*`); `docker-compose.yml` names `${TEAMS_AI_IMAGE:-ghcr.io/diego-dm-morais/teams-ai:latest}` and keeps `build: .`, so `task up` and `task start` pull and build only when the pull fails, and `task up:source` builds from source. Visibility: private package (the image holds the whole source), so each machine runs `docker login ghcr.io` once.
- Open: the first start of a private package without login falls back to the local build with only a compose warning.
```

In `docs/superpowers/plans/README.md`, after the row for plan 80 (or the last row present), add:

```markdown
| 82 | [`2026-10-12-teams-ai-82-prebuilt-image-ghcr.md`](2026-10-12-teams-ai-82-prebuilt-image-ghcr.md) | Done — `task up` and `task start` pull a prebuilt image from GHCR and build only when the pull fails; ROADMAP R9.4. |
```

- [ ] **Step 3: Run the full checks**

Run: `npx vitest run test/infra && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: first start pulls the prebuilt image, R9.4 done" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- README.md docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
```
