import { describe, expect, it } from 'vitest';
import { FLUTTER_VERSION, JUNITREPORT_VERSION, androidImageSteps } from '../../server/exec/android-toolchain.js';
import { renderRelease, validateWorkflow } from '../../server/orchestrator/workflows.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec({ specId: 'app-001' });
const flutterPlan = makePlan(spec, {
  stack: 'flutter',
  gateImage: 'node:22-bookworm',
  commands: { ...makePlan(spec).commands, install: 'flutter pub get && flutter build apk --debug', build: 'flutter build apk --debug' },
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
    const steps = androidImageSteps('flutter');
    const activate = steps.indexOf(`RUN dart pub global activate junitreport ${JUNITREPORT_VERSION}`);
    expect(JUNITREPORT_VERSION).toBe('2.0.2');
    expect(activate).toBeGreaterThan(steps.indexOf('RUN cd /opt/flutter/packages/flutter_tools && dart pub get'));
  });
});
