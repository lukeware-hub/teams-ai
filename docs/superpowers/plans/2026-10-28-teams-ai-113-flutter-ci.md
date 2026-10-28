# Plan 113 - Flutter CI setup

## Context

FEATURES item 2 (Flutter for Android, end to end) left one gap in the CI workflow: `renderCi` returned no setup step for a Flutter plan, so the generated `.github/workflows/ci.yml` could not run the Flutter commands. The release workflow already sets up Flutter, Java and the Android SDK.

## Change

1. `flutterSetup` in `server/orchestrator/workflows.ts` holds the Flutter, Java 17 and Android SDK steps at the gate's `FLUTTER_VERSION`. The release workflow and the CI setup both use it, so the version is not repeated.
2. `setupStep` returns `flutterSetup()` for a Flutter plan. The verify job and the e2e job both get it.
3. `validateWorkflow` (CI branch) requires the `subosito/flutter-action` step for a Flutter plan. The install command is already required for every stack.
4. The CI runs the plan commands in the usual order: install, format, lint, typecheck when set, test, build, then the secret scan.

## Verification

- `test/orchestrator/workflows-flutter.test.ts`: the CI steps and their order for a Flutter plan, the validator on a good CI, and the validator on a CI without the Flutter setup or the install command.
- The golden files of node, python, go and rust are unchanged. Flutter has no golden file.
- Typecheck (`npx tsc --noEmit`) and the two workflow test files pass.
