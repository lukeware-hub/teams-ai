---
name: java
description: Use when a Java or JVM build, compile, test, or runtime step fails (javac, Maven, Gradle, JUnit, ClassNotFoundException, NoSuchMethodError, UnsupportedClassVersionError).
---

# Java errors

## Diagnose

1. Read the first `ERROR` or `Caused by:` line. The last `Caused by:` is usually the root cause.
2. Record `java -version`, the compiler release (`maven.compiler.release` or `sourceCompatibility`), and the build tool version.
3. Check which JDK the build tool uses (`mvn -v` or `gradle -v` print it), since it can differ from the shell `java`.
4. Reproduce with the exact build command and change one thing at a time.

## Common errors

- `UnsupportedClassVersionError`: a dependency or the code was compiled for a newer Java than the runtime. Align the release with the runtime JDK.
- `ClassNotFoundException` or `NoClassDefFoundError`: the dependency is missing from the classpath or has a different scope (`provided` or `test`).
- `NoSuchMethodError`: two versions of one library are on the classpath. Inspect the tree (`mvn dependency:tree` or `gradle dependencies`) and pin one version.
- `package does not exist` during compile: the dependency is missing from the build file, or the generated sources were not produced.
- `invalid target release` or `release version not supported`: the JDK is older than the target release.
- Gradle daemon or wrapper download failures: check the proxy and the wrapper `distributionUrl`; never disable TLS verification.

## Standard tools

- `mvn -q -e test` or `./gradlew test --stacktrace` for full traces.
- `mvn dependency:tree` or `./gradlew dependencies` to find duplicate versions.
- `javap -classpath <jar> <class>` to see the methods a class really has.
- `jdeps` to see which modules a jar needs.

## Resolution flow

Follow the error flow in the agent rules: search with `agent-reach` (official docs, project issue trackers, Stack Overflow), apply the fix, and rerun the failing command.

## Solutions

The `solutions/` folder keeps notes from past runs for people. The agents do not read or write it, so a note there is never applied on its own.
