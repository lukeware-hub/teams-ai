#!/usr/bin/env bash
set -euo pipefail
docker rm -f omniroute >/dev/null 2>&1 || true
echo "OmniRoute container removed (volume omniroute-data kept)"
