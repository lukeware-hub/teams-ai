#!/bin/sh
# Rendered by teams-ai (roadmap R8.5): pinned versions, sha256-verified downloads. Do not edit.
set -eu
ROOT="$PWD"
BIN="$ROOT/.tools/bin"
TMP="$ROOT/.tools/tmp"
mkdir -p "$BIN" "$TMP"

# fetch URL SHA256 DEST: download, then refuse anything whose digest differs.
# With TEAMS_AI_GATE_CACHE set, a download whose digest still matches is reused instead of fetched again.
fetch() {
  C="${TEAMS_AI_GATE_CACHE:-}"
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

fetch "https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz" a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb "$TMP/gitleaks.tgz"
tar --no-same-owner -xzf "$TMP/gitleaks.tgz" -C "$BIN" gitleaks

fetch "https://github.com/google/osv-scanner/releases/download/v2.2.2/osv-scanner_linux_amd64" c799274b682e0437c802d4714a136ad09b39c65547c460049ba5358d28afa576 "$BIN/osv-scanner"
chmod +x "$BIN/osv-scanner"

fetch "https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz" c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f "$TMP/trivy.tgz"
tar --no-same-owner -xzf "$TMP/trivy.tgz" -C "$BIN" trivy

fetch "https://bootstrap.pypa.io/pip/zipapp/pip-24.3.1.pyz" c59df64b826d5baa978829fd1e1b3ea2e748f73dce7cce58d09aa28a1c9323a7 "$TMP/pip.pyz"
# The gate image (node:22-bookworm) has python3 but no pip, and apt does not work without capabilities: the pinned pip zipapp does.
# A folder of its own, emptied first: pip --target never replaces a folder already there, such as the bin/ of the project's packages in .tools/py.
rm -rf "$ROOT/.tools/semgrep"
python3 "$TMP/pip.pyz" install --quiet --disable-pip-version-check --root-user-action=ignore --target "$ROOT/.tools/semgrep" "semgrep==1.131.0" "setuptools<81"
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
paths = ['''(^|/)[.]tools/''', '''(^|/)(node_modules|target|[.]venv|__pycache__|[.]pytest_cache|[.]next)/''']
TOML

rm -rf "$TMP"
"$BIN/gitleaks" version
"$BIN/osv-scanner" --version
"$BIN/trivy" --version
"$BIN/semgrep" --version
