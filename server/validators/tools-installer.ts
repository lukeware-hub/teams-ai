
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
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

fetch "${g.url}" ${g.sha256} "$TMP/gitleaks.tgz"
tar -xzf "$TMP/gitleaks.tgz" -C "$BIN" gitleaks

fetch "${o.url}" ${o.sha256} "$BIN/osv-scanner"
chmod +x "$BIN/osv-scanner"

fetch "${t.url}" ${t.sha256} "$TMP/trivy.tgz"
tar -xzf "$TMP/trivy.tgz" -C "$BIN" trivy

python3 -m pip install --quiet --disable-pip-version-check --target "$ROOT/.tools/py" "semgrep==${SEMGREP_VERSION}"
cat > "$BIN/semgrep" <<'WRAP'
#!/bin/sh
D="$(cd "$(dirname "$0")/.." && pwd)"
PYTHONPATH="$D/py" exec python3 -m semgrep "$@"
WRAP
chmod +x "$BIN/semgrep"

rm -rf "$TMP"
"$BIN/gitleaks" version
"$BIN/osv-scanner" --version
"$BIN/trivy" --version
"$BIN/semgrep" --version
`;
}
