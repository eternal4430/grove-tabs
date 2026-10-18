#!/usr/bin/env bash
# Builds dist/grove-<version>.zip with the extension's files at the top level of the archive
# (no wrapping folder), excluding tests, CI and contrib files. Used by the release workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/grove-${version}.zip"
mkdir -p dist
rm -f "$out"
git ls-files -z -- manifest.json '*.js' '*.html' '*.css' lib fonts icons LICENSE README.md \
  ':!:tests/**' ':!:.github/**' ':!:contrib/**' ':!:scripts/**' \
  | xargs -0 zip -q -X "$out"
echo "$out"
