#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$ROOT_DIR"

required_files="
manifest.json
background.js
options.html
options.js
student_dashboard.html
student_dashboard.js
blocked.html
content.js
icons/icon16.png
icons/icon32.png
icons/icon48.png
icons/icon128.png
"

for path in $required_files; do
  if [ ! -f "$path" ]; then
    printf 'Missing required release file: %s\n' "$path" >&2
    exit 1
  fi
done

if rg -n --fixed-strings 'https://your-backend.com' config.js options.js >/dev/null; then
  printf 'Found placeholder backend URLs. Remove them before publishing.\n' >&2
  exit 1
fi

if rg -n --fixed-strings 'G-XXXXXXXXXX' config.js >/dev/null; then
  printf 'Found placeholder GA measurement ID. Remove it before publishing.\n' >&2
  exit 1
fi

if rg -n --fixed-strings 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' config.js >/dev/null; then
  printf 'Found placeholder production values. Remove them before publishing.\n' >&2
  exit 1
fi

printf 'Release validation passed.\n'
