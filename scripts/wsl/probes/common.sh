#!/usr/bin/env bash
# Shared helpers for CLI probes. Source this file.
set -euo pipefail
REC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/docs/superpowers/spikes/recordings"
mkdir -p "$REC_DIR"
SANDBOX_DIR="$(mktemp -d /tmp/teams-ai-probe-XXXX)"

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
