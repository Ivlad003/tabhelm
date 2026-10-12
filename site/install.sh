#!/usr/bin/env bash
# TabHelm installer (Linux, macOS).
#   curl -fsSL https://ivlad003.github.io/tabhelm/install.sh | bash
#
# Downloads the latest release into ~/.tabhelm/app, installs the native host's
# dependencies and registers it with Chrome, Chromium, Brave and Edge.
# Chrome only allows loading unpacked extensions by hand, so the last step
# (Load unpacked) is printed at the end.
#
# Environment overrides:
#   TABHELM_HOME     install root (default ~/.tabhelm)
#   TABHELM_TARBALL  release URL or local .tar.gz path (default: latest GitHub release)
set -euo pipefail

REPO="Ivlad003/tabhelm"
ROOT="${TABHELM_HOME:-$HOME/.tabhelm}"
APP="$ROOT/app"
TARBALL="${TABHELM_TARBALL:-https://github.com/$REPO/releases/latest/download/tabhelm.tar.gz}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux | Darwin) ;;
  *) fail "TabHelm's installer supports Linux and macOS." ;;
esac

command -v node >/dev/null || fail "Node.js 20+ is required: https://nodejs.org"
command -v npm >/dev/null || fail "npm is required (it ships with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ is required, found $(node -v)."

bold "Installing TabHelm into $APP"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -f "$TARBALL" ]; then
  cp "$TARBALL" "$TMP/tabhelm.tar.gz"
else
  echo "Downloading $TARBALL"
  curl -fsSL "$TARBALL" -o "$TMP/tabhelm.tar.gz" || fail "Download failed."
fi
tar -xzf "$TMP/tabhelm.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'tabhelm-*' | head -n 1)"
[ -n "$SRC" ] || fail "The archive does not contain a tabhelm-<version> folder."

mkdir -p "$ROOT"
rm -rf "$APP"
mv "$SRC" "$APP"

bold "Installing host dependencies (this can take a minute)"
(cd "$APP/host" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

bold "Registering the native host"
(cd "$APP/host" && node scripts/install.js)

VERSION="$(node -p "require('$APP/extension/manifest.json').version")"
echo
bold "✓ TabHelm $VERSION installed"
cat <<EOF

Last step — load the extension in Chrome:
  1. Open chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked" and choose:
       $APP/extension

Then click the TabHelm icon on any page, pick an agent and press Connect.
Agents found on this machine are listed in the panel; install more with:
  cd "$APP/host" && npm run install-agent -- --list

To update later, run the same install command again.
EOF
