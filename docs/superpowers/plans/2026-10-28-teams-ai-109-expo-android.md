# Plan 109 - Expo for Android, end to end

## Context

FEATURES item 2 covers the mobile delivery. Plan 108 built it for Flutter: the delivery kind `mobile`, the debug APK kept with the run, a JUnit report for the tests, and a release workflow on a tag. Expo is a Node stack that builds the Android app with Gradle, so it needs the Android SDK and a JDK, but not Flutter.

## Decisions

1. **Stack kind.** `expo` is a stack of its own, read from the plan stack text (`/\bexpo\b/`). The earliest mention wins, as for every stack, so the plan stack text names Expo first.
2. **Gate image.** The Expo image is the node image plus the JDK and the Android SDK (the same pinned SDK packages as Flutter). It has no Flutter. Gradle comes with the project's wrapper and keeps its cache in `.tools`.
3. **Install and build.** `commands.install` is `npm ci && npx expo prebuild --platform android`, and `commands.build` is `cd android && ./gradlew assembleDebug`. The debug APK at `android/app/build/outputs/apk/debug/app-debug.apk` is the delivery artifact.
4. **JUnit.** A jest project pins `jest-junit` exactly and writes `reports/junit.xml` through its reporter. The plan junitPath is `reports/junit.xml`.
5. **Release.** On a tag `v*` the workflow sets up Node (the gate version), Java 17 and the Android SDK, runs the install command and then the build command, and keeps the APK as a workflow artifact. The APK is the debug build, so it is signed with the debug key.

## Built

- `server/runner/stacks.ts`: the `expo` stack kind, its empty registry list, and `androidToolchainOf`, the one place that says which stacks carry the Android SDK.
- `server/exec/android-toolchain.ts`: the SDK steps are shared; Flutter adds its own steps on top. `androidImageSteps` takes the toolchain.
- `server/exec/gate-runner.ts`: the gate image flavour is the toolchain name, so a Flutter image and an Expo image never share a tag.
- `server/orchestrator/run.ts` and `server/orchestrator/phases/artifact.ts`: an Expo install runs in its gate image, with the Android SDK and the longer build timeout.
- `server/orchestrator/workflows.ts`: the release renders for either toolchain, and `validateWorkflow` checks each one's actions, build steps and APK path.
- `server/orchestrator/steps.ts`: the Expo guidance line for the plan rules.
- `server/validators/security-tooling.ts`: an Expo project gets the same `npm audit` as a node project.

## Verification

- Unit tests: stack detection, the Expo gate image (SDK, no Flutter), the release render and validator on a good and a broken release, and the artifact path (the APK is kept with the run, and a build that writes no APK fails).
- Typecheck: `npx tsc --noEmit`.

## Open questions for the owner

1. **Stack text order.** A plan that says "TypeScript Expo app" reads as node, because TypeScript is mentioned first. The guidance tells the plan to name Expo first.
2. **npm cache in the gate.** `npm ci` in the gate container uses the container user's home cache. The gate sets no npm cache directory, so a read-only home could fail the install. Not changed here, because moving the npm cache would change every node install.
3. **CI for Expo.** The CI pipeline runs no setup step for Expo, as for Flutter, so it uses the runner's preinstalled Node and Java.
4. **Release signing.** The APK is the debug build. A release signing key is a separate decision for the owner.
