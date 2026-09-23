#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
: "${OMNIROUTE_TOKEN:?set OMNIROUTE_TOKEN to an OmniRoute API key}"
: "${OMNIROUTE_MODEL:?set OMNIROUTE_MODEL to a pinned non-Claude model id}"
( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb \
    ANTHROPIC_BASE_URL=http://localhost:20128 ANTHROPIC_AUTH_TOKEN="$OMNIROUTE_TOKEN" ANTHROPIC_MODEL="$OMNIROUTE_MODEL" \
    claude -p "Reply with the single word OK." --tools "" --output-format stream-json --verbose \
      --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence \
  ) > "$REC_DIR/p6-omniroute.ndjson" 2> "$REC_DIR/p6-omniroute.stderr" || true
grep '"subtype":"init"' "$REC_DIR/p6-omniroute.ndjson" | head -c 400; echo
grep '"type":"result"' "$REC_DIR/p6-omniroute.ndjson" | tail -1 | head -c 600; echo
echo "check OmniRoute logs for X-OmniRoute-Decision of this request"
