import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FLUTTER_VERSION, JUNITREPORT_VERSION, androidImageSteps } from '../../server/exec/android-toolchain.js';
import { renderCi, renderRelease, validateWorkflow } from '../../server/orchestrator/workflows.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec({ specId: 'app-001' });
const flutterPlan = makePlan(spec, {
  stack: 'flutter',
  gateImage: 'node:22-bookworm',
  commands: { ...makePlan(spec).commands, install: 'flutter pub get && flutter build apk --debug', build: 'flutter build apk --debug' },
});
const flutterCiPlan = makePlan(spec, {
  stack: 'flutter',
  gateImage: 'node:22-bookworm',
  commands: { ...makePlan(spec).commands, install: 'flutter pub get', format: 'dart format --output=none --set-exit-if-changed .', lint: 'flutter analyze', typecheck: undefined, test: 'flutter test', build: 'flutter build apk --debug' },
});

describe('the Flutter CI workflow', () => {
  const ci = renderCi(flutterCiPlan);

  it('sets up Flutter, Java and the Android SDK, then runs the plan commands in order', () => {
    const steps = (parse(ci) as { jobs: { verify: { steps: Array<{ uses?: string; run?: string }> } } }).jobs.verify.steps;
    expect(steps.map((s) => s.uses ?? s.run)).toEqual([
      'actions/checkout@v4',
      'subosito/flutter-action@v2',
      'actions/setup-java@v4',
      'android-actions/setup-android@v3',
      'flutter pub get',
      'dart format --output=none --set-exit-if-changed .',
      'flutter analyze',
      'flutter test',
      'flutter build apk --debug',
      'gitleaks/gitleaks-action@v2',
    ]);
    expect(ci).toContain(`flutter-version: ${FLUTTER_VERSION}`);
  });

  it('passes the CI validator, and fails one without the Flutter setup or the install command', () => {
    expect(validateWorkflow('ci', ci, flutterCiPlan)).toEqual([]);
    expect(validateWorkflow('ci', ci.replace('subosito/flutter-action@v2', 'actions/other@v2'), flutterCiPlan)).toContain('ci is missing the flutter setup step');
    expect(validateWorkflow('ci', ci.replace('flutter pub get', 'echo skipped'), flutterCiPlan)).toContain('ci is missing the install step (flutter pub get)');
  });
});

describe('the Flutter release workflow', () => {
  it('builds the APK with the plan install command on the gate Flutter version, and keeps it as an artifact', () => {
    const text = renderRelease(flutterPlan);
    expect(text).toContain(`flutter-version: ${FLUTTER_VERSION}`);
    expect(text).toContain('flutter pub get && flutter build apk --debug');
    expect(text).toContain('build/app/outputs/flutter-apk/*.apk');
    expect(text).not.toContain('ghcr.io');
  });

  it('passes the release validator, and fails one that drops the APK step', () => {
    const text = renderRelease(flutterPlan);
    expect(validateWorkflow('release', text, flutterPlan)).toEqual([]);
    expect(validateWorkflow('release', text.replace('flutter build apk --debug', 'echo done'), flutterPlan)).toContain('release is missing the build step (install command)');
  });
});

describe('the Flutter gate image', () => {
  it('pins junitreport and activates it after the Dart packages are fetched', () => {
    const steps = androidImageSteps();
    const activate = steps.indexOf(`RUN dart pub global activate junitreport ${JUNITREPORT_VERSION}`);
    expect(JUNITREPORT_VERSION).toBe('2.0.2');
    expect(activate).toBeGreaterThan(steps.indexOf('RUN cd /opt/flutter/packages/flutter_tools && dart pub get'));
  });
});
