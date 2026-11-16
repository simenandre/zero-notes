#!/usr/bin/env bash
# Builds store-ready zips in dist/: one for Chrome and Edge, one for Firefox.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/chrome-extension"
dist="$root/dist"
build="$dist/extension"
gecko_id="${FIREFOX_GECKO_ID:-zero-notes@madsolame.com}"
version="$(jq -r .version "$src/manifest.json")"

rm -rf "$dist"
mkdir -p "$build"

cp -R "$src/." "$build/"
cp "$root/LICENSE" "$build/"
(cd "$build" && zip -qrX "$dist/zero-notes-chrome-$version.zip" . -x '.*')

jq --arg id "$gecko_id" '
  del(.minimum_chrome_version)
  | .background = { scripts: ["sites.js", "background.js"] }
  | .browser_specific_settings.gecko = {
      id: $id,
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] }
    }
' "$src/manifest.json" > "$build/manifest.json"
(cd "$build" && zip -qrX "$dist/zero-notes-firefox-$version.zip" . -x '.*')
rm -rf "$build"

echo "$version"
