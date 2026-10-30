---
name: typescript-node
description: Use when a TypeScript or Node.js install, build, type check, test, or runtime step fails (npm, pnpm, corepack, tsc, vitest, tsx, ESM import errors, module resolution, EACCES during install).
---

# TypeScript and Node.js errors

## Diagnose

1. Read the first error line. For TypeScript, read the first `error TS` line; later lines are often consequences.
2. Record `node --version`, the package manager version, and the `engines` field of `package.json`.
3. Check the lock file matches the manifest: `npm ci` fails when they differ, and the message says so.
4. For a runtime stack, find the first frame inside the project, not inside `node_modules`.

## Common errors

- `EACCES` when writing under `/usr/local/bin` or another system path (for example `corepack enable` or `npm i -g`): the step user cannot write there. Use a user-writable prefix, such as `npm config set prefix` to a workspace folder, or call `corepack` through `npx`.
- `ERR_MODULE_NOT_FOUND` or `Cannot find module`: check the import extension in ESM (`./file.js` for TypeScript sources), and check the `type` field of `package.json`.
- `ERR_REQUIRE_ESM`: the package is ESM-only; import it with `import` or use dynamic `import()`.
- `TS2307 Cannot find module`: check `paths` and `moduleResolution` in `tsconfig.json`, and that the package has types installed.
- `npm ERR! code EUSAGE` or `npm ci can only install packages when your package.json and package-lock.json are in sync`: run `npm install` once with the same Node version, then commit the lock file.
- `ERR_PNPM_OUTDATED_LOCKFILE`: run `pnpm install` and commit `pnpm-lock.yaml`.

## Standard tools

- `npx tsc --noEmit` for type checks.
- `npm ls <package>` or `pnpm why <package>` to see which dependency pulls a version.
- `node --version`, `npm config get prefix`, `corepack --version` for the environment.
- The project test runner (for example `npx vitest run`) with the failing file path.

## Resolution flow

Follow the error flow in the agent rules: search with `agent-reach` (official docs, package issue trackers, Stack Overflow), apply the fix, and rerun the failing command.

## Solutions

The `solutions/` folder keeps notes from past runs for people. The agents do not read or write it, so a note there is never applied on its own.
