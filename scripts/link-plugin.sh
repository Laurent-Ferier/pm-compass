#!/usr/bin/env bash
# Build the plugin and symlink main.js/manifest.json/styles.css into a vault's
# .obsidian/plugins/pm-compass directory, so future rebuilds are picked up by
# Obsidian without re-copying.
#
# Usage:   scripts/link-plugin.sh <vault-path>
# Example: scripts/link-plugin.sh ~/Documents/MyVault
#
# For a one-off copy that doesn't need the source repo to stick around, use
# update-plugin.sh instead.
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
for file in main.js manifest.json styles.css; do
  src="$ROOT/$file"
  [[ -f "$src" ]] || continue
  ln -sf "$src" "$DEST/$file"
  echo "  linked $DEST/$file -> $src"
done

echo "pm-compass linked in $DEST"
