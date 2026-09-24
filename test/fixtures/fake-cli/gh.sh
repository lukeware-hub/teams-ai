#!/usr/bin/env bash
# Fake `gh auth login --web` for the onboarding tests. Scenario via FAKE_CLI_SCENARIO (default: success).
set -u
scenario="${FAKE_CLI_SCENARIO:-success}"
echo "! First copy your one-time code: FAKE-CODE"
echo "Press Enter to open https://github.com/login/device in your browser..."
IFS= read -r _ || true
sleep 0.2
case "$scenario" in
  bad-code) echo "error: The code is invalid"; exit 1 ;;
  *) echo "✓ Logged in as fake-user"; exit 0 ;;
esac
