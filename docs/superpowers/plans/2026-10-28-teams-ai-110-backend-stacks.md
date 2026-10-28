# Plan 110 - Backend stacks: Java, .NET and the per-stack allowlists

## Context

FEATURES item 6, part a. Before this plan, the Dev and Test sandboxes got npm for every stack, the npm registry was open for every stack, and only Go, Rust and Python had toolchain commands. Java and .NET were read as `other`. Ruby and PHP are out of this delivery.

## Decisions

1. **Stack kinds.** `java` (Maven or Gradle, from the plan text or the gate image) and `dotnet` (.NET, C#, ASP.NET) join node, python, go, rust, flutter and other.
2. **Allowlists per stack.** The Front, Dev and Test roles get the toolchain commands of their stacks only: node gets npm, npx, pnpm, corepack and node; python gets python3 and the venv pip and pytest; go gets go and gofmt; rust gets cargo and rustc; java gets java, javac, mvn, gradle and their wrappers; dotnet gets dotnet. Other roles get no toolchain.
3. **Network.** The npm registry opens only for a node stack. Java opens Maven Central and the Gradle hosts; .NET opens the NuGet API.
4. **Dependency scan.** Java and .NET use osv-scanner over the lockfile, as `other` already did. A stack-native audit is not used: Maven has none without a plugin that downloads a database, and `dotnet list package --vulnerable` does not reliably fail on findings. Node keeps `npm audit`, Python `pip-audit`, Go osv-scanner without call analysis.
5. **Gate setup.** CI setup for Java uses `actions/setup-java` with the Temurin distribution and the version of the gate image; .NET uses `actions/setup-dotnet` with the version of `dotnet/sdk`.
6. **Caches.** Maven's local repository, the NuGet packages and the .NET CLI home live in the worktree's `.tools`, since the step HOME is read-only.

## Changes

- `server/runner/stacks.ts`: stack kinds and patterns, registries, per-stack `STACK_BASH`, `stackBash`, cache variables; node framework names (react, vue and others) read as node so they keep npm.
- `server/runner/role-settings.ts`: the shared list loses npm and node; the Front, Dev and Test roles add the stacks' commands.
- `server/runner/step.ts`, `server/orchestrator/run.ts`: the run's stacks reach the role settings through the step dependencies.
- `server/orchestrator/workflows.ts`: setup for Java and .NET.

## Verification

- `npx tsc --noEmit` passes.
- `npx vitest run` on the runner, exec and validator tests and the workflow and run orchestrator tests passes.
- The golden workflow files for node, python, go and rust are unchanged.

## Open questions for the owner

1. A stack-native audit for Java or .NET (OWASP dependency-check, `dotnet list package --vulnerable --exit-code`) instead of osv-scanner.
2. Flutter Dev and Test lose npm; a Flutter step needs its own commands if it runs one.
3. Detection of the stack from free text: a plan that names none of the known stacks now gets no toolchain, not npm.
