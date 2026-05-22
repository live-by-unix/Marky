#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WWW="$(cd "$(dirname "$0")/.." && pwd)/www"

mkdir -p "$WWW"

cp "$ROOT/app.js" "$WWW/app.js"
cp "$ROOT/style.css" "$WWW/style.css"
cp "$ROOT/favicon.svg" "$WWW/favicon.svg"

echo "Synced app assets to electron/www/"
