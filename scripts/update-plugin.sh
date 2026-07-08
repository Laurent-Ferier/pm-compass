#!/usr/bin/env bash
# Build the plugin and copy main.js/manifest.json/styles.css into a vault's
# .obsidian/plugins/pm-compass directory (overwriting any previous copy).
#
# Usage:   scripts/update-plugin.sh <vault-path>
# Example: scripts/update-plugin.sh ~/Documents/MyVault
#
# For iterative local development, prefer link-plugin.sh instead — it symlinks
# the built files so you don't need to re-run this after every change.
set -euo pipefail

VAULT="${1:-}"

if [[ -z "$VAULT" ]]; then
  echo "Usage: $0 <vault-path>"
  exit 1
fi

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "Error: '$VAULT' does not look like an Obsidian vault (no .obsidian directory found)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DEST="$VAULT/.obsidian/plugins/pm-compass"

echo "Building…"
pnpm --dir "$ROOT" build

mkdir -p "$DEST"
cp "$ROOT/main.js" "$DEST/main.js"
cp "$ROOT/manifest.json" "$DEST/manifest.json"
[[ -f "$ROOT/styles.css" ]] && cp "$ROOT/styles.css" "$DEST/styles.css"

echo "Updated pm-compass in $DEST"
