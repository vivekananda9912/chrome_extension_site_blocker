#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"
ZIP_PATH="$DIST_DIR/lab-policy-whitelist-chrome-web-store.zip"

mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"

zip -r "$ZIP_PATH" \
  manifest.json \
  background.js \
  content.js \
  content.css \
  blocked.html \
  blocked.js \
  options.html \
  options.js \
  student_dashboard.html \
  student_dashboard.js \
  auth.js \
  utils.js \
  config.js \
  icons \
  vendor \
  LICENSE \
  README.md \
  CHROME_WEB_STORE.md

printf 'Created %s\n' "$ZIP_PATH"
