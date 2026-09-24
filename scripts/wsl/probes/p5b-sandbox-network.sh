#!/usr/bin/env bash
# Network allowlist probe with the real sandbox (bubblewrap + socat present). Allows curl so the
# result reflects the sandbox network policy rather than the permission mode (p5 showed that in
# dontAsk mode a non-allowlisted Bash call is denied before the sandbox is involved).
source "$(dirname "$0")/common.sh"
mkdir -p "$SANDBOX_DIR/.claude"
cat > "$SANDBOX_DIR/.claude/settings.json" <<'JSON'
{
  "sandbox": { "enabled": true, "network": { "allowedDomains": ["registry.npmjs.org"] } },
  "permissions": {
    "allow": ["Bash(curl:*)"],
    "deny": ["Read(~/.teams-ai/secrets/**)", "Bash(gh:*)", "Bash(git push:*)", "Bash(docker:*)", "Bash(kubectl:*)"]
  }
}
JSON
run_isolated p5b-net-denied  "Run exactly: curl -sS -m 8 https://example.com -o /dev/null -w '%{http_code}' ; then report the raw output or error message verbatim." --tools Bash
run_isolated p5b-net-allowed "Run exactly: curl -sS -m 8 https://registry.npmjs.org/-/ping -o /dev/null -w '%{http_code}' ; then report the raw output or error message verbatim." --tools Bash
for p in p5b-net-denied p5b-net-allowed; do
  echo "== $p"; grep '"type":"result"' "$REC_DIR/$p.ndjson" | tail -1 | head -c 700; echo
  echo "-- stderr:"; head -c 300 "$REC_DIR/$p.stderr"; echo
done
