#!/usr/bin/env bash
# Prints a JSON tool report for server/env/tool-report.ts. Read-only.
set -euo pipefail

version_of() {
  local name="$1"
  case "$name" in
    node) node --version 2>/dev/null ;;
    npm) npm --version 2>/dev/null ;;
    git) git --version 2>/dev/null | awk '{print $3}' ;;
    claude) claude --version 2>/dev/null | awk '{print $1}' ;;
    gh) gh --version 2>/dev/null | head -1 | awk '{print $3}' ;;
    docker) docker version --format '{{.Client.Version}}' 2>/dev/null ;;
    kind) kind version 2>/dev/null | awk '{print $2}' ;;
    kubectl) kubectl version --client -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' | head -1 ;;
    gitleaks) gitleaks version 2>/dev/null ;;
    osv-scanner) osv-scanner --version 2>/dev/null | head -1 | awk '{print $NF}' ;;
    graphify) pipx list --short 2>/dev/null | awk '/^graphifyy /{print $2}' ;;
    nvidia-smi) nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 ;;
    llama-server) llama-server --version 2>&1 | head -1 ;;
    *) echo "" ;;
  esac
}

tools=(node npm git claude gh docker kind kubectl gitleaks osv-scanner graphify nvidia-smi llama-server)
first=1
printf '{"host":{"kernel":"%s","distro":"%s","onLinuxFs":%s},"tools":[' \
  "$(uname -r)" "${WSL_DISTRO_NAME:-unknown}" \
  "$( [[ "$(pwd -P)" == /mnt/* ]] && echo false || echo true )"
for t in "${tools[@]}"; do
  # Only Linux binaries count: Windows interop exposes /mnt/c/... tools (kubectl.exe, npm.cmd) that the orchestrator must not use.
  if p="$(command -v "$t" 2>/dev/null)" && [[ "$p" != /mnt/* ]]; then present=true; v="$(version_of "$t" || true)"; else present=false; v=""; fi
  [[ $first -eq 1 ]] || printf ','
  first=0
  if [[ -n "$v" ]]; then printf '{"name":"%s","present":%s,"version":"%s"}' "$t" "$present" "${v//\"/}"
  else printf '{"name":"%s","present":%s,"version":null}' "$t" "$present"; fi
done
printf ']}\n'
