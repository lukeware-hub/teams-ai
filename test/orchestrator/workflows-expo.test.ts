import { describe, expect, it } from 'vitest';
import type { Plan } from '../../server/contracts/plan.js';
import { androidImageSteps } from '../../server/exec/android-toolchain.js';
import { renderRelease, validateWorkflow } from '../../server/orchestrator/workflows.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec({ specId: 'app-001' });
const INSTALL = 'npm ci && npx expo prebuild --platform android';
const BUILD = 'cd android && ./gradlew assembleDebug';
const APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const { image: _image, port: _port, healthcheckPath: _path, ...container } = makePlan(spec).deploy;
const mobileDeploy = { ...container, kind: 'mobile', artifact: APK } as Plan['deploy'];
const expoPlan = makePlan(spec, {
  stack: 'Expo app, Android only',
  commands: { ...makePlan(spec).commands, install: INSTALL, build: BUILD },
  deploy: mobileDeploy,
});

describe('the Expo release workflow', () => {
  it('builds the debug APK with the plan commands on Node and the Android SDK, and keeps it as an artifact', () => {
    const text = renderRelease(expoPlan);
    expect(text).toMatch(/node-version: ['"]?22['"]?/);
    expect(text).toContain('android-actions/setup-android@v3');
    expect(text).toContain(INSTALL);
    expect(text).toContain(BUILD);
    expect(text).toContain('android/app/build/outputs/apk/debug/*.apk');
    expect(text).not.toContain('flutter');
    expect(text).not.toContain('ghcr.io');
  });

  it('passes the release validator, and fails one that drops the build or the APK', () => {
    const text = renderRelease(expoPlan);
    expect(validateWorkflow('release', text, expoPlan)).toEqual([]);
    expect(validateWorkflow('release', text.replace(BUILD, 'echo done'), expoPlan)).toContain('release is missing the build step (build command)');
    expect(validateWorkflow('release', text.replace(INSTALL, 'echo done'), expoPlan)).toContain('release is missing the build step (install command)');
    expect(validateWorkflow('release', text.replaceAll('android/app/build/outputs/apk/debug', 'out'), expoPlan)).toContain('release must keep the APK');
  });
});

describe('the Expo gate image', () => {
  it('adds the JDK and the Android SDK, and no Flutter', () => {
    const steps = androidImageSteps('expo').join('\n');
    for (const piece of ['openjdk-17-jdk-headless', 'ANDROID_HOME=/opt/android-sdk', 'sdkmanager', 'ndk;28.2.13676358']) expect(steps).toContain(piece);
    expect(steps).not.toContain('flutter');
  });
});
