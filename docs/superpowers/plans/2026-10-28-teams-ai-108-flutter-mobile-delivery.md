# Plan 108 - Flutter mobile delivery: what is left

## Context

FEATURES item 2 (Flutter for Android, end to end) lists four pending pieces. Checked in the code on 2026-10-28, two of them are already built:

- **Delivery kind `mobile`, the APK as the artifact, no container and no port.** Built: `server/orchestrator/phases/artifact.ts` installs and builds in the gate image, keeps `debug.apk` with the run, and journals `DEPLOY_VERIFIED` with `kind: 'mobile'`.
- **A download route and a download link on the validation screen.** Built: `GET /runs/:runId/artifact` in `server/api/run-routes.ts` serves the kept APK, and `ArtifactDownload` in `web/src/pages/Validation.tsx` shows the link.

Still open:

1. **A release workflow that builds the APK.** Absent: `.github/workflows/ci.yml` has no Flutter or APK step.
2. **A JUnit report for `flutter test`.** Absent: the gate guidance (`server/orchestrator/steps.ts`, the Flutter line) runs `flutter test` without a report, and no validator requires `junitPath` for a Flutter plan.

The download screen already exists, so no new screen mock is needed. A change to its text or layout would need one.

## Decisions for the owner

1. **Where the release workflow lives.** (a) In each generated Flutter project, built on a tag: it runs `flutter build apk --release` and attaches the APK. (b) In the teams-ai repository itself: teams-ai has no Flutter code, so it would not build anything. Recommended: (a).
2. **How `flutter test` writes JUnit.** (a) A pinned Dart package (`junitreport`) in the gate image, converting `flutter test --reporter json`. (b) A small script in the generated repository that does the conversion. Recommended: (a), because it is pinned like the other gate tools.

## Change (after the decisions)

1. The gate image pins the chosen converter, and the Flutter guidance runs `flutter test --reporter json | <converter> > reports/junit.xml`.
2. A Flutter plan must declare `junitPath`, and the validator rejects a Flutter plan without it.
3. The release workflow template for a Flutter project, added by the devops role at the bootstrap of a Flutter repository.

## Verification

- Unit tests: the validator rejects a Flutter plan without `junitPath`; the guidance text carries the converter command; the workflow template builds an APK in a fake runner.
- Gate: one Flutter item through the real gate image, checking that `reports/junit.xml` has one case per test.
- Release: the workflow runs on a tag of a scratch Flutter project and attaches the APK.
- Browser: none, because the download screen does not change.
