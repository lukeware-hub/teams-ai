#!/usr/bin/env bash
# Fake `claude auth login` for the onboarding tests. Scenario via FAKE_CLI_SCENARIO (default: success).
set -u
scenario="${FAKE_CLI_SCENARIO:-success}"
case "$scenario" in
  no-url) exit 0 ;;
  timeout) sleep 60; exit 1 ;;
esac
echo "Opening browser to sign in…"
sleep 0.05
printf '\033[1mhttps://claude.example/oauth/authorize?code=true&state=FAKE\033[0m\n'
sleep 0.05
printf 'Paste code here if prompted > '
IFS= read -r code || code=""
case "$scenario" in
  bad-code) echo "Invalid code: ${code}"; exit 1 ;;
  *) echo "Login successful. Welcome back!"; exit 0 ;;
esac
