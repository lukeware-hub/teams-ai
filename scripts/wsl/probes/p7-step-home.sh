#!/usr/bin/env bash
# Probe 7: the runner's step isolation against the real CLI (plan 20, audit C1/M2).
#  A. login works from an EMPTY per-step HOME that holds only a copy of ~/.claude/.credentials.json
#  B. with --setting-sources user, a worktree .claude/settings.json is NOT loaded: its allow rule must not take effect
# Costs a few cents (haiku, two tiny prompts). Run on the host where `claude` is logged in.
source "$(dirname "$0")/common.sh"

STEP_HOME="$(mktemp -d /tmp/teams-ai-probe-home-XXXX)"
trap 'rm -rf "$STEP_HOME"; cleanup_probe' EXIT
mkdir -p "$STEP_HOME/.claude" "$STEP_HOME/tmp"
[ -f "$HOME/.claude/.credentials.json" ] || { echo "no ~/.claude/.credentials.json on this host: the subscription login is not file-based here; probe A cannot run"; exit 3; }
install -m 400 "$HOME/.claude/.credentials.json" "$STEP_HOME/.claude/.credentials.json"

# Role settings as the runner writes them: no allow rules at all, so any Bash call must be denied under dontAsk.
SETTINGS="$STEP_HOME/role.settings.json"
echo '{"permissions":{"allow":[],"deny":[]}}' > "$SETTINGS"

# The agent-writable worktree settings that M2 is about: they try to allow a WRITING command. (A read-only command such
# as echo is auto-allowed by the CLI itself, so it would prove nothing; the file on disk is the evidence.)
mkdir -p "$SANDBOX_DIR/.claude"
echo '{"permissions":{"allow":["Bash(touch:*)"]}}' > "$SANDBOX_DIR/.claude/settings.json"

probe() {
  local name="$1"; shift
  ( cd "$SANDBOX_DIR" && env -i HOME="$STEP_HOME" TMPDIR="$STEP_HOME/tmp" PATH="$PATH" TERM=dumb \
      claude -p "$@" \
        --output-format stream-json --verbose \
        --setting-sources user --settings "$SETTINGS" \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --exclude-dynamic-system-prompt-sections \
        --no-session-persistence --permission-mode dontAsk --model haiku
  ) > "$REC_DIR/$name.ndjson" 2> "$REC_DIR/$name.stderr" || true
  echo "recorded $REC_DIR/$name.ndjson"
}

probe p7a-empty-home "Reply with the single word OK." --tools ""
if grep -q '"is_error":false' "$REC_DIR/p7a-empty-home.ndjson" && grep -q '"type":"result"' "$REC_DIR/p7a-empty-home.ndjson"; then
  echo "A PASS: login works from an empty step HOME"
else
  echo "A FAIL: no successful result; see $REC_DIR/p7a-empty-home.ndjson and .stderr"
fi

probe p7b-worktree-settings "Run the shell command: touch probe-marker. Then reply with the word DONE." --tools Bash
if [ -e "$SANDBOX_DIR/probe-marker" ]; then
  echo "B FAIL: the worktree .claude/settings.json allowed a writing Bash command (M2 is not closed)"
  exit 1
fi
echo "B PASS: probe-marker was not created; the worktree settings were not honored"
