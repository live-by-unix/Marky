#!/usr/bin/env bash
set -euo pipefail

VENDOR="$(cd "$(dirname "$0")/.." && pwd)/vendor"

mkdir -p "$VENDOR"

curl -fsSL "https://cdn.tailwindcss.com?plugins=typography" -o "$VENDOR/tailwindcss.js"
curl -fsSL "https://cdn.jsdelivr.net/npm/marked/marked.min.js" -o "$VENDOR/marked.min.js"
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js" -o "$VENDOR/highlight.min.js"
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css" -o "$VENDOR/github.min.css"
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css" -o "$VENDOR/github-dark.min.css"

echo "Downloaded offline vendor assets to electron/vendor/"
