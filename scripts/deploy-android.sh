#!/usr/bin/env bash
#
# Build the plugin, push it to an Obsidian vault on a USB-connected Android phone, restart
# the app, and optionally grab a screenshot — the loop for checking how a change actually
# renders on a phone rather than in a narrow desktop window.
#
#   ./scripts/deploy-android.sh --list                       # show the vaults on the device
#   ./scripts/deploy-android.sh /sdcard/MyVault
#   ./scripts/deploy-android.sh --shot /tmp/after.png /sdcard/MyVault
#   OBSIDIAN_VAULT=/sdcard/MyVault ./scripts/deploy-android.sh
#
# The vault is the folder containing `.obsidian/`, not the plugin folder itself. There is no
# default: vault paths are specific to a device, so --list is the way to discover them.
#
# Beyond deploying, this forwards Obsidian's WebView debugger to localhost:9222, which allows
# inspecting the live DOM — computed styles, element boxes, why a row overflows — instead of
# guessing at CSS. Obsidian's mobile stylesheet overrides plugin layout in ways that don't
# reproduce on desktop, so measuring the real thing is usually the fastest way to a cause:
#
#   curl -s http://localhost:9222/json/list      # find the page target
#   # then drive Runtime.evaluate over its webSocketDebuggerUrl. Obsidian's `app` global is
#   # in scope there, e.g. app.setting.openTabById("pm-compass").
#
set -euo pipefail

readonly APP_ID="md.obsidian"
readonly PLUGIN_ID="pm-compass"
readonly DEVTOOLS_PORT=9222
readonly VAULT_SEARCH_DEPTH=6

# No default: a vault path is device-specific, so it must be given via $OBSIDIAN_VAULT or --vault.
VAULT="${OBSIDIAN_VAULT:-}"
VAULT_ARG=""
SHOT=""
LIST_ONLY=false

usage() {
  cat <<'EOF'
Build the plugin, deploy it to an Obsidian vault on a connected Android phone, and restart
the app so the changes are live. See the comments at the top of this file for the WebView
debugging workflow.

Usage: deploy-android.sh [options] [<vault-path>]

The vault is the folder containing `.obsidian/`, not the plugin folder. It is required, and
may be given positionally (as in link-plugin.sh), with --vault, or as $OBSIDIAN_VAULT.
Options may appear before or after the vault path.

  -v, --vault PATH   Vault to deploy into; same as passing it positionally.
  -s, --shot FILE    Write a screenshot of the running app to FILE.
  -l, --list         List the vaults found on the device, then exit.
  -h, --help         Show this message.

Examples:
  ./scripts/deploy-android.sh --list
  ./scripts/deploy-android.sh /sdcard/MyVault
  ./scripts/deploy-android.sh --shot /tmp/after.png /sdcard/MyVault
EOF
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vault|-v)
      # `shift 2` would fail under `set -u` if the flag were passed with no value.
      [ $# -ge 2 ] || { echo "--vault needs a path" >&2; exit 2; }
      VAULT="$2"; shift 2 ;;
    --shot|-s)
      [ $# -ge 2 ] || { echo "--shot needs a file path" >&2; exit 2; }
      SHOT="$2"; shift 2 ;;
    --list|-l) LIST_ONLY=true; shift ;;
    --help|-h) usage 0 ;;
    -*) echo "Unknown option: $1" >&2; usage 2 ;;
    # A bare path is taken as the vault, matching link-plugin.sh / update-plugin.sh, which
    # both take the vault positionally.
    *)
      [ -z "$VAULT_ARG" ] || { echo "Unexpected extra argument: $1" >&2; usage 2; }
      VAULT_ARG="$1"; shift ;;
  esac
done

# A positional vault wins over $OBSIDIAN_VAULT, the same way --vault does.
[ -n "$VAULT_ARG" ] && VAULT="$VAULT_ARG"

# Lists every directory on the device holding a `.obsidian/` folder.
#
# `find -L` is required, not a nicety: /sdcard is a symlink to the real storage mount, and
# find won't descend through it without -L (`find /sdcard` returns only "/sdcard" itself).
# The device shell is mksh, which has no globstar, so `**` is not an option for this.
#
# Depth is capped only to stop the search running away on a large /sdcard; it is set deep
# enough to find nested vaults, which costs a few seconds and is worth it. Vault-shaped junk
# is pruned: sync tools and Obsidian itself keep backup copies that contain a `.obsidian/`
# but are not vaults you want to deploy into.
find_vaults() {
  local script="find -L /sdcard -maxdepth $VAULT_SEARCH_DEPTH \
    \( -name Android -o -name '.stversions' -o -name '.trash' -o -name '.git' \) -prune \
    -o -type d -name '.obsidian' -print 2>/dev/null"
  # `|| true`: find exits non-zero on any unreadable directory, which under `pipefail` would
  # abort the script even though the search itself succeeded.
  { adb shell "$script" 2>/dev/null || true; } | sed 's#/\.obsidian$##' | tr -d '\r'
}

if ! adb get-state >/dev/null 2>&1; then
  echo "No device: connect the phone, unlock it, and enable USB debugging." >&2
  exit 1
fi

if [ "$LIST_ONLY" = true ]; then
  echo "Vaults found on device:"
  find_vaults | sed 's/^/  /'
  exit 0
fi

# Checked after the device probe above, so the suggestions below are real paths.
if [ -z "$VAULT" ]; then
  {
    echo "No vault given. Pass --vault PATH (or set \$OBSIDIAN_VAULT)."
    echo "Vaults found on the device:"
    find_vaults | sed 's/^/  /'
  } >&2
  exit 2
fi

readonly DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

# Fail early with something actionable: a wrong vault path is the likeliest mistake here, so
# show what the device actually has rather than just reporting the missing directory.
if ! adb shell "test -d '$DEST'" 2>/dev/null; then
  {
    echo "Plugin not installed at: $DEST"
    echo "Pass the vault with --vault. Vaults found on the device:"
    find_vaults | sed 's/^/  /'
  } >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Building"
pnpm build

# These three files are the whole plugin as far as Obsidian is concerned.
echo "==> Deploying to $DEST"
adb push main.js "$DEST/main.js" >/dev/null
adb push styles.css "$DEST/styles.css" >/dev/null
adb push manifest.json "$DEST/manifest.json" >/dev/null

# Obsidian reads a plugin's JS/CSS only at startup, so nothing above is live until it restarts.
echo "==> Restarting Obsidian"
adb shell am force-stop "$APP_ID"
adb shell am start -n "$APP_ID/.MainActivity" >/dev/null
sleep 7

# The devtools socket name embeds the app's PID, so it has to be re-resolved on every restart
# — a forward set up against the previous process points at nothing.
SOCK="$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 || true)"
if [ -n "$SOCK" ]; then
  # Only this script's own port — `--remove-all` would drop forwards other tools rely on.
  adb forward --remove "tcp:$DEVTOOLS_PORT" >/dev/null 2>&1 || true
  adb forward "tcp:$DEVTOOLS_PORT" "localabstract:$SOCK" >/dev/null
  echo "==> DevTools on http://localhost:$DEVTOOLS_PORT (socket $SOCK)"
else
  echo "==> WebView debugger not exposed; skipping port forward" >&2
fi

if [ -n "$SHOT" ]; then
  adb exec-out screencap -p > "$SHOT"
  echo "==> Screenshot: $SHOT"
fi
