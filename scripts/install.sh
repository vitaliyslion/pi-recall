#!/usr/bin/env bash
#
# install.sh — install pi-recall as a per-project Pi extension.
#
# A directory extension loads its entry (index.ts) from the extension root; that entry re-exports
# ./src/index.ts, so the package is copied with its structure intact. The set of files to copy is
# read from package.json's `files` field (the single source of truth for what ships), plus
# package.json itself. See the "Install" section of README.md. Pi loads the TypeScript directly via
# jiti; no build step.
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

for cmd in npm node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: $cmd not found on PATH" >&2
    exit 1
  }
done

# Resolve the repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

DEST="$(cd "$PROJECT" && pwd)/.pi/extensions/pi-recall"

echo "Installing pi-recall -> $DEST"
mkdir -p "$DEST"

# Source of truth: package.json `files`. npm always ships package.json implicitly (it is not listed
# in `files`), and Pi needs it for the extension manifest + dependency install, so copy it too.
FILES_RAW="$(cd "$REPO_ROOT" && node -e 'for (const f of (require("./package.json").files || [])) console.log(f)')"
[ -n "$FILES_RAW" ] || {
  echo "error: package.json has no 'files' list to install" >&2
  exit 1
}
mapfile -t FILES <<<"$FILES_RAW"

cp "$REPO_ROOT/package.json" "$DEST/"
for f in "${FILES[@]}"; do
  # Strip any trailing slash (e.g. "src/") so cp -R lands the entry at $DEST/<name>.
  cp -R "$REPO_ROOT/${f%/}" "$DEST/"
done

echo "Installing runtime dependencies..."
(cd "$DEST" && npm install --omit=dev)

echo "Done. Trust the project in Pi, then verify with /recall-status."
