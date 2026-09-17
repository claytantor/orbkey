#!/usr/bin/env bash
#
# orbkey one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/claytantor/orbkey/main/install.sh | bash
#
# Clones the repo (or updates it if already present), installs dependencies,
# builds, and links the `orbkey` binary onto your PATH. No secrets touched, no
# AWS calls — just a local build. Read it before you pipe it.
#
# Once installed, `orbkey --update` moves this same checkout to the newest
# tagged release and rebuilds it in place.

set -euo pipefail

REPO_URL="${ORBKEY_REPO_URL:-https://github.com/claytantor/orbkey.git}"
INSTALL_DIR="${ORBKEY_INSTALL_DIR:-$HOME/.local/share/orbkey}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; }

# --- preflight ---------------------------------------------------------------
command -v git >/dev/null 2>&1 || { err "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { err "Node.js >= 20 is required"; exit 1; }

if ! command -v pnpm >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  err "pnpm or npm is required"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js >= 20 required (found $(node -v))"
  exit 1
fi

# --- fetch / update ----------------------------------------------------------
# The clone is shallow (--depth 1) to keep the install fast. `orbkey --update`
# unshallows it on demand, so release tags are still reachable later.
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing checkout in $INSTALL_DIR"
  if git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null 2>&1; then
    git -C "$INSTALL_DIR" pull --ff-only
  else
    # Detached HEAD: this checkout is parked on a release tag by `orbkey
    # --update`. Don't yank it onto a branch behind the user's back.
    info "Checkout is on a release tag (detached HEAD); rebuilding in place."
    info "Run 'orbkey --update' to move to the newest release."
  fi
else
  info "Cloning $REPO_URL -> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- build -------------------------------------------------------------------
# Use the package manager this repo actually locks against: pnpm, with npm as
# the fallback when pnpm isn't installed.
if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then
  info "Installing dependencies (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile

  info "Building (tsc -> dist/)"
  pnpm run build
else
  info "Installing dependencies (npm ci)"
  npm ci

  info "Building (tsc -> dist/)"
  npm run build
fi

# --- link --------------------------------------------------------------------
# Either way the global `orbkey` symlinks into this checkout's dist/, so an
# in-place rebuild (what `orbkey --update` does) needs no relink.
if command -v npm >/dev/null 2>&1; then
  info "Linking the 'orbkey' binary onto your PATH (npm link)"
  npm link
else
  info "Linking the 'orbkey' binary onto your PATH (pnpm link --global)"
  pnpm link --global
fi

# --- done --------------------------------------------------------------------
info "Done. Run 'orbkey' to start."
echo
echo "  orbkey --help      what the CLI accepts"
echo "  orbkey --version   what's installed"
echo "  orbkey --update    move this checkout to the newest tagged release"
echo
echo "  Next: provision your AWS vault backend with the CDK stack in:"
echo "    $INSTALL_DIR/devops/"
echo "  See $INSTALL_DIR/devops/README.md and devops/cookbooks/."
