# corepack enable fails with EACCES

- **Error:** `EACCES` when `corepack enable` tries to create `/usr/local/bin/pnpm`
- **Context:** Node.js with corepack; the gate step runs as a user that cannot write to `/usr/local/bin`; observed in a web project install step
- **Root cause:** `corepack enable` creates shims in the Node install directory by default, which the step user cannot write
- **Solution:** not yet applied. Candidate fixes: point the shim directory to a user-writable path with `corepack enable --install-directory <dir>` and add that directory to `PATH`, or call `corepack pnpm` / `npx pnpm@<version>` without enabling shims
- **Source:** observed in run kayron-hub--tenant-identity-authority--run-7, task T0-scaffold-web-bff-web, gate install
- **Date:** 2026-10-21
- **Status:** not validated
