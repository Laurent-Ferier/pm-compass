#!/usr/bin/env bash
# Build the plugin and copy main.js/manifest.json/styles.css into a vault's
# .obsidian/plugins/pm-compass directory (overwriting any previous copy).
#
# Usage:   scripts/update-plugin.sh [--dev] <vault-path>
# Example: scripts/update-plugin.sh ~/Documents/MyVault
#          scripts/update-plugin.sh --dev ~/Documents/MyVault
#
# Copies the minified bundle a release ships. --dev copies a readable one with an
# inline sourcemap instead, for when a stack trace out of that vault has to mean
# something.
#
# For iterative local development, prefer link-plugin.sh instead — it symlinks
# the built files so you don't need to re-run this after every change.
set -euo pipefail

DEV=false
if [[ "${1:-}" == "--dev" || "${1:-}" == "-d" ]]; then
  DEV=true
  shift
fi

VAULT="${1:-}"

if [[ -z "$VAULT" ]]; then
  echo "Usage: $0 [--dev] <vault-path>"
  exit 1
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "Error: '$VAULT' does not look like an Obsidian vault (no .obsidian directory found)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DEST="$VAULT/.obsidian/plugins/pm-compass"

if [[ "$DEV" == true ]]; then
  echo "Building (dev: readable, with sourcemap)…"
  pnpm --dir "$ROOT" build:dev
else
  echo "Building (minified, as released)…"
  pnpm --dir "$ROOT" build
fi

mkdir -p "$DEST"
cp "$ROOT/main.js" "$DEST/main.js"
cp "$ROOT/manifest.json" "$DEST/manifest.json"
[[ -f "$ROOT/styles.css" ]] && cp "$ROOT/styles.css" "$DEST/styles.css"

echo "Updated pm-compass in $DEST"
