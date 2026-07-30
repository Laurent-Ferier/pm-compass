#!/usr/bin/env bash
# Build the plugin and symlink main.js/manifest.json/styles.css into a vault's
# .obsidian/plugins/pm-compass directory, so future rebuilds are picked up by
# Obsidian without re-copying.
#
# Usage:   scripts/link-plugin.sh [--dev] <vault-path>
# Example: scripts/link-plugin.sh ~/Documents/MyVault
#          scripts/link-plugin.sh --dev ~/Documents/MyVault
#
# Builds the minified bundle a release ships. --dev builds a readable one with an
# inline sourcemap instead. The links outlive the build, so a later `pnpm build:dev`
# or `pnpm dev` swaps what this vault loads without re-running this script.
#
# For a one-off copy that doesn't need the source repo to stick around, use
# update-plugin.sh instead.
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
for file in main.js manifest.json styles.css; do
  src="$ROOT/$file"
  [[ -f "$src" ]] || continue
  ln -sf "$src" "$DEST/$file"
  echo "  linked $DEST/$file -> $src"
done

echo "pm-compass linked in $DEST"
