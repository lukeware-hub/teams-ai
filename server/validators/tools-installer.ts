import { UNCOMMITTED_BUILD_DIRS } from '../runner/stacks.js';
/** Where the orchestrator renders the installer inside the worktree, and the command the install gate must run. */
export const INSTALLER_PATH = '.tools/install.sh';
export const INSTALLER_COMMAND = `sh ${INSTALLER_PATH}`;

/** Pinned releases; the sha256 values come from each project's published checksum file (linux amd64). */
export const PINNED_TOOLS = {
  gitleaks: {
    version: '8.28.0',
    url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz',
    sha256: 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb',
  },
  'osv-scanner': {
    version: '2.2.2',
    url: 'https://github.com/google/osv-scanner/releases/download/v2.2.2/osv-scanner_linux_amd64',
    sha256: 'c799274b682e0437c802d4714a136ad09b39c65547c460049ba5358d28afa576',
  },
  trivy: {
    version: '0.75.0',
    url: 'https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz',
    sha256: 'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f',
  },
} as const;
export const SEMGREP_VERSION = '1.131.0';
export const PIP_PYZ_URL = 'https://bootstrap.pypa.io/pip/zipapp/pip-24.3.1.pyz';
export const PIP_PYZ_SHA256 = 'c59df64b826d5baa978829fd1e1b3ea2e748f73dce7cce58d09aa28a1c9323a7';

/** Deterministic installer for the scanner gates; same input, same bytes (golden-file tested). */
export function renderToolsInstaller(): string {
  const g = PINNED_TOOLS.gitleaks;
  const o = PINNED_TOOLS['osv-scanner'];
  const t = PINNED_TOOLS.trivy;
  return `#!/bin/sh
# Rendered by teams-ai (roadmap R8.5): pinned versions, sha256-verified downloads. Do not edit.
set -eu
ROOT="$PWD"
BIN="$ROOT/.tools/bin"
TMP="$ROOT/.tools/tmp"
mkdir -p "$BIN" "$TMP"

# fetch URL SHA256 DEST: download, then refuse anything whose digest differs.
# With TEAMS_AI_GATE_CACHE set, a download whose digest still matches is reused instead of fetched again.
fetch() {
  C="\${TEAMS_AI_GATE_CACHE:-}"
  if [ -n "$C" ] && [ -f "$C/dl/$2" ] && echo "$2  $C/dl/$2" | sha256sum -c - >/dev/null 2>&1; then
    cp "$C/dl/$2" "$3"
    return
  fi
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
  if [ -n "$C" ]; then
    mkdir -p "$C/dl" && cp "$3" "$C/dl/$2.tmp" && mv "$C/dl/$2.tmp" "$C/dl/$2" || true
  fi
}

fetch "${g.url}" ${g.sha256} "$TMP/gitleaks.tgz"
tar --no-same-owner -xzf "$TMP/gitleaks.tgz" -C "$BIN" gitleaks

fetch "${o.url}" ${o.sha256} "$BIN/osv-scanner"
chmod +x "$BIN/osv-scanner"

fetch "${t.url}" ${t.sha256} "$TMP/trivy.tgz"
tar --no-same-owner -xzf "$TMP/trivy.tgz" -C "$BIN" trivy

fetch "${PIP_PYZ_URL}" ${PIP_PYZ_SHA256} "$TMP/pip.pyz"
# The gate image (node:22-bookworm) has python3 but no pip, and apt does not work without capabilities: the pinned pip zipapp does.
# A folder of its own, emptied first: pip --target never replaces a folder already there, such as the bin/ of the project's packages in .tools/py.
rm -rf "$ROOT/.tools/semgrep"
python3 "$TMP/pip.pyz" install --quiet --disable-pip-version-check --root-user-action=ignore --target "$ROOT/.tools/semgrep" "semgrep==${SEMGREP_VERSION}" "setuptools<81"
cat > "$BIN/semgrep" <<'WRAP'
#!/bin/sh
D="$(cd "$(dirname "$0")/.." && pwd)"
# semgrep execs pysemgrep from PATH and imports pkg_resources (setuptools < 81 still ships it).
PATH="$D/semgrep/bin:$PATH" PYTHONPATH="$D/semgrep" SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 exec python3 "$D/semgrep/bin/semgrep" "$@"
WRAP
chmod +x "$BIN/semgrep"

# The scanners must not scan themselves: .tools holds their binaries and python packages (a gitleaks false positive blocked the scaffold).
cat > "$ROOT/.tools/gitleaks.toml" <<'TOML'
[extend]
useDefault = true
[allowlist]
paths = ['''(^|/)[.]tools/''', '''(^|/)(${UNCOMMITTED_BUILD_DIRS.map((d) => d.replace('.', '[.]')).join('|')})/''']
TOML

rm -rf "$TMP"
"$BIN/gitleaks" version
"$BIN/osv-scanner" --version
"$BIN/trivy" --version
"$BIN/semgrep" --version
`;
}
