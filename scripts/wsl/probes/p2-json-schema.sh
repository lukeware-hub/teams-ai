#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
SCHEMA='{"type":"object","properties":{"specHash":{"type":"string"},"status":{"enum":["done","spec-gap"]}},"required":["specHash","status"],"additionalProperties":false}'
run_isolated p2-valid "Return specHash 'sha256:aa' and status done." --tools "" --json-schema "$SCHEMA"
run_isolated p2-impossible "Return status 'finished'." --tools "" --json-schema "$SCHEMA"
echo "valid result line:"; grep '"type":"result"' "$REC_DIR/p2-valid.ndjson" | tail -1 | head -c 800; echo
echo "impossible result line:"; grep '"type":"result"' "$REC_DIR/p2-impossible.ndjson" | tail -1 | head -c 800; echo
