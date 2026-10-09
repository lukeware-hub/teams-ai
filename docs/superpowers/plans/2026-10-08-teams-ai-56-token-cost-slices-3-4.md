# Plan 56 - Token cost and run speed, slices 3 and 4 (R11.13)

## Slice 3 - graphify in the image

- `Dockerfile`: `pipx` from apt, then `pipx install graphifyy==0.9.67` into `/opt/pipx` with the binaries in `/usr/local/bin` (the version the CLI spike recorded). Before this the image had no `graphify`, the workspace `graph/` directories stayed empty and every pack said "no matches".
- Checked in a throwaway `node:22-bookworm` container, as a non-root user: install works (210 MB), `graphify update . --no-cluster` on `server/` builds a graph of 1,594 nodes.
- Takes effect when the image is rebuilt (`docker compose up -d --build`); not rebuilt here because other sessions use the running container.

## Slice 4 - shared cache for the security gates

- `paths.gateCache` (default `~/.teams-ai/gate-cache`), created open (0777: the rootless gate user is not the orchestrator user) and passed as `GateContext.cacheDir`.
- `dockerArgs` mounts it at `/gate-cache` for `security-tools` and `image-scan` only (their commands are prescribed and validated verbatim, so an agent-written gate command cannot poison it), through the bind rewrite, with `TEAMS_AI_GATE_CACHE`, `TRIVY_CACHE_DIR` (vulnerability DB) and `PIP_CACHE_DIR` (semgrep wheels).
- The rendered installer's `fetch` reuses `$TEAMS_AI_GATE_CACHE/dl/<sha256>` when the digest still matches, otherwise downloads, verifies and stores it; a tampered cache entry is re-fetched (checked in a Linux container: hit, and tamper then re-fetch).
- Expected: ~12-14 min less gate time per run, no tokens. Not cached: the semgrep rules fetched from semgrep.dev, and the unpack/pip install step itself (a symlinked shared `.tools` was left out: gitleaks and the scanners walk the worktree).

## Verification

- Unit: `test/exec/gate-runner.test.ts` (cache mounted only for the two gates, rewritten), installer golden file regenerated; typecheck clean; `test/exec`, `test/validators`, `test/config`, `test/orchestrator` green (428 tests).
- Live (pending): rebuild the image, run one task; compare `security-tools` (was ~23 s) and `image-scan` (was ~19 s) on the second task onward.
