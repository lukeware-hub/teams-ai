# Live check of the documentation repository (2026-11-02)

Plan 119, run on a local stack with the flag on. Two throwaway projects, GitHub owner `diego-dm-morais`.
This record states only what was observed. Nothing here is a claim beyond these facts.

## Monolith: dr-live-mono

- The refinement closed and development started.
- The documentation store has 13 commits, from the initial documents to the closing commit.
- The start tag is `dev-start/greeting-route`, one tag for the one spec.
- The repository `main` on GitHub holds 8 files under `docs/`. All 8 match the allowed layout.
- The development run started. Its outcome is not recorded here.

## Microservices: dr-live-micro2

- The architecture is decided with two services: an API and a jobs service. The names changed between attempts.
- The documentation store has 46 commits.
- The refinement reached ready after convergence.
- The closing checks did not pass after three rounds. The open checks named the project document, the architecture decision and the no-contradictions checklist.
- The project did not start, so it has no start tag.
- The central repository `artefacty` holds 47 files under `docs/`. The allowlist accepts all 47. It also holds files from earlier attempts that used other service names.

## Open after this run

- The full test suite on the current `main` has not finished.
- Production runs the image built from `38199ef3` with the flag off. The `main` branch is at a later commit.
- The test repositories `dr-live-mono` and `artefacty` still exist on GitHub. They are not deleted.
