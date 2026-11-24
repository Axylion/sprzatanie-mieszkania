#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ -e dist || -L dist ]]; then
  printf '%s\n' 'Build output dist already exists. Move it before rebuilding.' >&2
  exit 1
fi

staging=$(mktemp -d .dist-ui8.XXXXXX)
trap 'rm -rf -- "$staging"' EXIT

git ls-files -z -- \
  index.html sw.js pwa-install.js manifest.webmanifest favicon.svg \
  icon-192.png icon-512.png icon-maskable-512.png announcements.json \
  administracja dyskusje kalendarz ogloszenia poradnik |
while IFS= read -r -d '' file; do
  if [[ ! -f $file || -L $file ]]; then
    printf 'Expected a regular site file: %s\n' "$file" >&2
    exit 1
  fi
  install -D -m 0644 -- "$file" "$staging/$file"
done

test -s "$staging/index.html"
test -s "$staging/sw.js"
mv -T -- "$staging" dist
