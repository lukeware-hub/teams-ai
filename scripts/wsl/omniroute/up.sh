#!/usr/bin/env bash
# Pinned OmniRoute gateway for the non-Claude provider profile (spec §10). Never route the Claude subscription through it.
# Preconfigured so /dashboard/onboarding is skipped: every key has a local-dev default, override via env or ~/.teams-ai/secrets.
set -euo pipefail
VERSION="${OMNIROUTE_VERSION:-3.8.51}"
SECRETS_DIR="${TEAMS_AI_SECRETS:-$HOME/.teams-ai/secrets}"
mkdir -p "$SECRETS_DIR"

# Read NAME from env, else from the secrets dir, else generate (random) or use the default and persist it.
secret() { # name default|@random
  local name="$1" def="$2" file="$SECRETS_DIR/$1"
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; return; fi
  if [ -s "$file" ]; then cat "$file"; return; fi
  [ "$def" = "@random" ] && def="$(openssl rand -hex 32)"
  printf '%s' "$def" | tee "$file" >/dev/null; chmod 600 "$file"; printf '%s' "$def"
}

INITIAL_PASSWORD="$(secret OMNIROUTE_INITIAL_PASSWORD teams-ai-local)"   # admin password; unset => onboarding loop on 3.8.51
JWT_SECRET="$(secret OMNIROUTE_JWT_SECRET @random)"
API_KEY_SECRET="$(secret OMNIROUTE_API_KEY_SECRET @random)"
GEMINI_API_KEY="${GEMINI_API_KEY:-$( [ -s "$SECRETS_DIR/GEMINI_API_KEY" ] && cat "$SECRETS_DIR/GEMINI_API_KEY" || true )}"

docker rm -f omniroute >/dev/null 2>&1 || true
docker run -d --name omniroute --restart unless-stopped -p 127.0.0.1:20128:20128 \
  -e INITIAL_PASSWORD="$INITIAL_PASSWORD" -e JWT_SECRET="$JWT_SECRET" -e API_KEY_SECRET="$API_KEY_SECRET" \
  ${GEMINI_API_KEY:+-e GEMINI_API_KEY="$GEMINI_API_KEY"} \
  -v omniroute-data:/app/data "diegosouzapw/omniroute:${VERSION}"
echo "OmniRoute ${VERSION} on http://localhost:20128 — login with the password in $SECRETS_DIR/OMNIROUTE_INITIAL_PASSWORD."
[ -n "$GEMINI_API_KEY" ] || echo "No GEMINI_API_KEY (env or $SECRETS_DIR/GEMINI_API_KEY): add the Gemini provider in the dashboard."
echo "Still manual: pin a Gemini model, create an API key with compression disabled, save it as OMNIROUTE_TOKEN."
