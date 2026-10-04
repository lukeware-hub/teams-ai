#!/usr/bin/env bash
# Pinned OmniRoute gateway for the non-Claude provider profile (spec §10). Never route the Claude subscription through it.
set -euo pipefail
VERSION="${OMNIROUTE_VERSION:?set OMNIROUTE_VERSION to a pinned release, e.g. 3.8.51}"
docker run -d --name omniroute --restart unless-stopped -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data "diegosouzapw/omniroute:${VERSION}"
echo "OmniRoute ${VERSION} on http://localhost:20128 — open the dashboard, add a free provider, pin a model, create an API key, disable compression for that key."
