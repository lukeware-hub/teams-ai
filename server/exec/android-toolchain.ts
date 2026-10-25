/**
 * The Android toolchain a Flutter gate image carries. Every download is pinned and checked against its sha256,
 * and the image is derived once per host, like the browser image.
 */
export const FLUTTER_VERSION = '3.47.8';
export const FLUTTER_ARCHIVE = `https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz`;
export const FLUTTER_SHA256 = 'baf7dcc5a3dbba60fe863bf493a6cf203195621f7786eaa5a1bba02cd0d87dd2';
export const CMDLINE_TOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip';
export const CMDLINE_TOOLS_SHA256 = '2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258';
/** The SDK packages a Flutter Android build needs: the platform the Flutter template compiles against, its build tools and the NDK. */
export const SDK_PACKAGES = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0', 'ndk;28.2.13676358'];
/** Flutter's own pub cache inside the image, baked with the tool's dependencies; a gate copies the project's packages into it. */
export const FLUTTER_PUB_CACHE = '/opt/pub-cache';
/** Tag of a gate image derived with the Android toolchain (see `prepareGateImage`). */
export const ANDROID_IMAGE_TAG = /^teams-ai-gate:.*-android-[a-f0-9]{12}$/;

/** The Dockerfile lines that add the Android toolchain to a gate image; the tool's own pub dependencies are baked in here. */
export const androidImageSteps = (): string[] => [
  'RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip xz-utils && rm -rf /var/lib/apt/lists/*',
  `RUN curl -fsSL ${FLUTTER_ARCHIVE} -o /tmp/flutter.tar.xz && echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c - && tar -xJf /tmp/flutter.tar.xz -C /opt && rm /tmp/flutter.tar.xz && git config --system --add safe.directory /opt/flutter`,
  'ENV FLUTTER_ROOT=/opt/flutter ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk PATH=/opt/flutter/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH',
  'RUN flutter config --no-analytics && flutter precache --android',
  `RUN curl -fsSL ${CMDLINE_TOOLS_URL} -o /tmp/cmd.zip && echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmd.zip" | sha256sum -c - && mkdir -p /opt/android-sdk/cmdline-tools && unzip -q /tmp/cmd.zip -d /tmp/cmd && mv /tmp/cmd/cmdline-tools /opt/android-sdk/cmdline-tools/latest && rm -rf /tmp/cmd /tmp/cmd.zip`,
  `RUN yes | sdkmanager --licenses >/dev/null && sdkmanager ${SDK_PACKAGES.map((p) => `"${p}"`).join(' ')}`,
  `ENV PUB_CACHE=${FLUTTER_PUB_CACHE}`,
  'RUN cd /opt/flutter/packages/flutter_tools && dart pub get',
  `RUN chmod -R a+rwX /opt/flutter /opt/android-sdk ${FLUTTER_PUB_CACHE}`,
];

/**
 * A gate command of the Android image: the project's packages (fetched by install into .tools) join the image's pub cache first,
 * so the Flutter tool finds its own dependencies and the project's in one place.
 */
export const androidCommand = (command: string): string =>
  `export PUB_CACHE=${FLUTTER_PUB_CACHE}; cp -rn /work/.tools/pub-cache/hosted ${FLUTTER_PUB_CACHE}/ 2>/dev/null; cp -rn /work/.tools/pub-cache/hosted-hashes ${FLUTTER_PUB_CACHE}/ 2>/dev/null; ${command}`;
