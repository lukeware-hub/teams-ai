# Plan 37: image scan without docker, verifiable tool install

## Goal

Close the plan 32 known limit (gates have no docker, so `trivy image --input` had no archive) and make the
`security-tools` install gate deterministic instead of a free-form command.

## Options weighed

- (a) The deploy build exports an OCI archive and the gate runs `trivy image --input .tools/image.tar`. Rejected as the
  gate: task gates run per task in Phase 3, long before the Phase 5 deploy build, so the archive does not exist when the
  gate runs, and the gate would fail on every first run.
- (b) `trivy config` (Dockerfile, manifests) and `trivy fs` (source tree, dependencies, secrets). Needs no archive, runs
  in every gate container. Chosen as the always-available `image-scan` gate.
- Both, in effect: the build-side export from (a) is implemented too, so a later Phase 5 scan has its input. Nothing
  scans the archive yet (see Known limit).

## Approach

- `image-scan` prescribed command: `trivy config --severity CRITICAL --exit-code 1 . && trivy fs --scanners vuln,secret
  --severity CRITICAL --exit-code 1 .`. The validator accepts only `trivy config|fs` segments joined with `&&`, requires
  both subcommands, `--severity CRITICAL` and `--exit-code 1` on every segment, and rejects disarming (`|| true`,
  `--exit-code 0`). `trivy image` is no longer accepted. Each segment needs its own `PATH=` prefix (env prefix binds to
  one command).
- `DeploymentIntent.imageArchive` (repo-relative, set to `.tools/image.tar` by `deployIntent` when the plan has an
  `image-scan` gate). `KindTarget.build` adds `--output type=oci,dest=<abs>` to the buildctl call (registry mode) or runs
  `docker save -o` after `docker build`; `DockerLocalTarget.build` runs `docker save -o` after `docker build`. The
  compose path builds in `apply` and does not export. A failed export fails the build.
- `server/validators/tools-installer.ts` renders `.tools/install.sh`: pinned gitleaks 8.28.0, osv-scanner 2.2.2, trivy
  0.75.0 with sha256 checks taken from each project's published checksum file (linux amd64), and semgrep 1.131.0 from
  pip (`--target .tools/py`, wrapper in `.tools/bin`; pip gives a version pin, not a hash). Golden file:
  `test/fixtures/tools-install.sh`.
- `server/orchestrator/tools-install.ts` writes it into the worktree before gates run (`run.ts` `gates`, one line).
- The validator requires the `security-tools` gate command to be exactly `sh .tools/install.sh`.
- `sm.md` and the plan-pack text (`securityToolingRules`) state both rules.

## Known limit

- The exported archive is not scanned by any gate yet; wiring a Phase 5 `trivy image --input` step needs a gate type that
  runs after deploy build.
- Pins are amd64 only; an arm64 gate image would fail the sha256 check (loudly).
- semgrep is version-pinned, not hash-pinned.

## Verification

Unit tests: validator accept/reject, golden installer, export command per target with the fake Exec, intent flag, installer
write; tsc; full vitest suite.
