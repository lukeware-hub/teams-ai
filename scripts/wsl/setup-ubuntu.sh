#!/usr/bin/env bash
# Installs the teams-ai toolchain inside a WSL2 Ubuntu distro. Idempotent.
# Docker comes from Docker Desktop's WSL integration, not from apt.
set -euo pipefail

need_sudo() { if [[ $EUID -ne 0 ]]; then sudo "$@"; else "$@"; fi; }

echo "== apt base"
need_sudo apt-get update -y
need_sudo apt-get install -y curl git unzip ca-certificates gnupg python3 python3-pip pipx build-essential cmake

echo "== node 22 via nvm"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm alias default 22 >/dev/null
# Login shells (bash -lc, how the orchestrator spawns processes) read ~/.profile, not ~/.bashrc;
# nvm must load there and before the Windows interop PATH so Linux node/claude win.
if ! grep -q "nvm for non-interactive login shells" "$HOME/.profile" 2>/dev/null; then
  cat >> "$HOME/.profile" <<'PROFILE'

# nvm for non-interactive login shells (orchestrator uses bash -lc)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
PROFILE
fi

echo "== claude code cli"
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

echo "== gh"
if ! command -v gh >/dev/null 2>&1; then
  need_sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | need_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | need_sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  need_sudo apt-get update -y && need_sudo apt-get install -y gh
fi

echo "== kind + kubectl"
if ! command -v kind >/dev/null 2>&1; then
  curl -fsSLo /tmp/kind "https://kind.sigs.k8s.io/dl/v0.29.0/kind-linux-amd64"
  need_sudo install -m 755 /tmp/kind /usr/local/bin/kind
fi
if ! command -v kubectl >/dev/null 2>&1; then
  curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
  need_sudo install -m 755 /tmp/kubectl /usr/local/bin/kubectl
fi

echo "== gitleaks + osv-scanner"
if ! command -v gitleaks >/dev/null 2>&1; then
  curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz | tar -xz -C /tmp gitleaks
  need_sudo install -m 755 /tmp/gitleaks /usr/local/bin/gitleaks
fi
if ! command -v osv-scanner >/dev/null 2>&1; then
  curl -fsSLo /tmp/osv-scanner https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64
  need_sudo install -m 755 /tmp/osv-scanner /usr/local/bin/osv-scanner
fi

echo "== graphify"
pipx ensurepath >/dev/null 2>&1 || true
pipx list 2>/dev/null | grep -q graphifyy || pipx install graphifyy

echo "== docker (Docker Desktop WSL integration)"
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found: enable 'WSL integration' for this distro in Docker Desktop settings" >&2
fi

echo "== done"
bash "$(dirname "$0")/check-tools.sh"
