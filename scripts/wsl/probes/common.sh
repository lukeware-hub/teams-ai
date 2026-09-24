#!/usr/bin/env bash
# Shared helpers for CLI probes. Source this file.
set -euo pipefail
REC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/docs/superpowers/spikes/recordings"
mkdir -p "$REC_DIR"
SANDBOX_DIR="$(mktemp -d /tmp/teams-ai-probe-XXXX)"

# Project-level permissions.allow entries are ignored unless the workspace is trusted
# (hasTrustDialogAccepted in ~/.claude.json). The orchestrator must do the same for every worktree.
trust_dir() {
  node -e '
    const fs = require("fs"); const f = process.env.HOME + "/.claude.json";
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    j.projects = j.projects || {}; j.projects[process.argv[1]] = { ...(j.projects[process.argv[1]] || {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$1"
}
trust_dir "$SANDBOX_DIR"

untrust_dir() {
  node -e '
    const fs = require("fs"); const f = process.env.HOME + "/.claude.json";
    if (!fs.existsSync(f)) process.exit(0);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j.projects) delete j.projects[process.argv[1]];
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$1"
}

# Probes must not leave state behind: remove the temp workspace and its trust entry on exit.
cleanup_probe() { untrust_dir "$SANDBOX_DIR"; rm -rf "$SANDBOX_DIR"; }
trap cleanup_probe EXIT

# Runs claude headless with the orchestrator's isolation flags; stream saved to $REC_DIR/$1.ndjson.
run_isolated() {
  local name="$1"; shift
  ( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb \
      claude -p "$@" \
        --output-format stream-json --verbose \
        --setting-sources project \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --exclude-dynamic-system-prompt-sections \
        --no-session-persistence \
        --permission-mode dontAsk \
    ) > "$REC_DIR/$name.ndjson" 2> "$REC_DIR/$name.stderr" || true
  echo "recorded $REC_DIR/$name.ndjson"
}

# Same prompt, default settings (user + project + plugins), for the baseline comparison.
run_default() {
  local name="$1"; shift
  ( cd "$SANDBOX_DIR" && claude -p "$@" --output-format stream-json --verbose --no-session-persistence --permission-mode dontAsk ) \
    > "$REC_DIR/$name.ndjson" 2> "$REC_DIR/$name.stderr" || true
  echo "recorded $REC_DIR/$name.ndjson"
}

usage_of() { grep '"type":"result"' "$REC_DIR/$1.ndjson" | tail -1 | sed 's/.*"usage":\({[^}]*}\).*/\1/'; }
