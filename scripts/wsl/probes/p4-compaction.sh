#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
# Force compaction early by shrinking the auto-compact window, then make the model read a large file twice.
head -c 400000 /dev/urandom | base64 > "$SANDBOX_DIR/big.txt"
( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb CLAUDE_CODE_AUTO_COMPACT_WINDOW=30000 \
    claude -p "Read big.txt fully, then read it again, then reply DONE." \
      --output-format stream-json --verbose --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
      --no-session-persistence --permission-mode dontAsk --tools Read \
  ) > "$REC_DIR/p4-compaction.ndjson" 2> "$REC_DIR/p4-compaction.stderr" || true
echo "system events:"; grep '"type":"system"' "$REC_DIR/p4-compaction.ndjson" | cut -c1-300
