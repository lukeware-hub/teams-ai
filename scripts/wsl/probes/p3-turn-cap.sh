#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
claude --version
if claude --help 2>&1 | grep -q -- '--max-turns'; then
  echo "native --max-turns: present"
  run_isolated p3-max-turns "Count from 1 to 50, one number per tool call, using Bash echo." --tools Bash --max-turns 2
  grep '"type":"result"' "$REC_DIR/p3-max-turns.ndjson" | tail -1 | head -c 600; echo
else
  echo "native --max-turns: ABSENT — runner cap is the only mechanism"
fi
