#!/usr/bin/env bash
#
# orbkey one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/claytantor/orbkey/main/install.sh | bash
#
# Clones the repo (or updates it if already present), installs dependencies,
# builds, and links the `orbkey` binary onto your PATH. No secrets touched, no
# AWS calls — just a local build. Read it before you pipe it.

set -euo pipefail

REPO_URL="${ORBKEY_REPO_URL:-https://github.com/claytantor/orbkey.git}"
INSTALL_DIR="${ORBKEY_INSTALL_DIR:-$HOME/.local/share/orbkey}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; }

# --- preflight ---------------------------------------------------------------
command -v git >/dev/null 2>&1 || { err "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { err "Node.js >= 20 is required"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm is required"; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js >= 20 required (found $(node -v))"
  exit 1
fi

# --- fetch / update ----------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning $REPO_URL -> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- build -------------------------------------------------------------------
info "Installing dependencies (npm ci)"
npm ci

info "Building (tsc -> dist/)"
npm run build

info "Linking the 'orbkey' binary onto your PATH (npm link)"
npm link

# --- done --------------------------------------------------------------------
info "Done. Run 'orbkey' to start."
echo
echo "  Next: provision your AWS vault backend with the CDK stack in:"
echo "    $INSTALL_DIR/devops/"
echo "  See $INSTALL_DIR/devops/README.md and devops/cookbooks/."
