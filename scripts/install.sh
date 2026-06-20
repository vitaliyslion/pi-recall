#!/usr/bin/env bash
#
# install.sh — install pi-recall as a per-project Pi extension.
#
# A directory extension loads its entry (index.js) from the extension root; that entry re-exports
# ./src/index.js, so the package is copied with its structure intact (index.js + src/ + package.json)
# — see the "Install" section of README.md.
#
# Usage:
#   scripts/install.sh <project-dir>
#
# Installs into <project-dir>/.pi/extensions/pi-recall. The project must be trusted in Pi for the
# extension to load.

set -euo pipefail

usage() {
  echo "Usage: $0 <project-dir>" >&2
  echo "  Installs pi-recall into <project-dir>/.pi/extensions/pi-recall" >&2
  exit 2
}

[ $# -eq 1 ] || usage
case "$1" in -h | --help) usage ;; esac

PROJECT="$1"
if [ ! -d "$PROJECT" ]; then
  echo "error: '$PROJECT' is not a directory" >&2
  exit 1
fi

command -v npm >/dev/null 2>&1 || {
  echo "error: npm not found on PATH" >&2
  exit 1
}

# Resolve the repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

DEST="$(cd "$PROJECT" && pwd)/.pi/extensions/pi-recall"

echo "Installing pi-recall -> $DEST"
mkdir -p "$DEST"
cp "$REPO_ROOT/index.js" "$REPO_ROOT/package.json" "$DEST/"
cp -r "$REPO_ROOT/src" "$DEST/"

echo "Installing runtime dependencies..."
(cd "$DEST" && npm install --omit=dev)

echo "Done. Trust the project in Pi, then verify with /recall-status."
