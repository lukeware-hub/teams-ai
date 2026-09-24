#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
run_default  p1-default  "Reply with the single word OK." --tools ""
run_isolated p1-isolated "Reply with the single word OK." --tools ""
echo "default : $(usage_of p1-default)"
echo "isolated: $(usage_of p1-isolated)"
echo "init events (compare 'tools', 'mcp_servers', 'slash_commands'):"
grep '"subtype":"init"' "$REC_DIR/p1-default.ndjson" | head -c 600; echo
grep '"subtype":"init"' "$REC_DIR/p1-isolated.ndjson" | head -c 600; echo
