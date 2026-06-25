#!/usr/bin/env bash
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
PLUGIN_DIR="$ROOT/packages/plugin"
DEST="$VAULT/.obsidian/plugins/pm-compass"

echo "Building…"
pnpm --dir "$ROOT" build

mkdir -p "$DEST"
cp "$PLUGIN_DIR/main.js" "$DEST/main.js"
cp "$PLUGIN_DIR/manifest.json" "$DEST/manifest.json"
[[ -f "$PLUGIN_DIR/styles.css" ]] && cp "$PLUGIN_DIR/styles.css" "$DEST/styles.css"

echo "Updated pm-compass in $DEST"
