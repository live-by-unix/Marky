#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WWW="$(cd "$(dirname "$0")/.." && pwd)/www"

mkdir -p "$WWW"

cp "$ROOT/app.js" "$WWW/app.js"
cp "$ROOT/filesystem.js" "$WWW/filesystem.js"
cp "$ROOT/style.css" "$WWW/style.css"
cp "$ROOT/favicon.svg" "$WWW/favicon.svg"

python3 <<PY
from pathlib import Path

root_index = Path("$ROOT") / "index.html"
www_index = Path("$WWW") / "index.html"
text = root_index.read_text()
body_start = text.index("<body")
body = text[body_start:]

desktop_badge = (
    '          <span class="hidden rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] '
    'font-medium text-violet-600 dark:text-violet-400 sm:inline">Desktop</span>\n'
)
marker = '<h1 class="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-white">Marky</h1>'
if "Desktop</span>" not in body:
    body = body.replace(marker, marker + "\n" + desktop_badge, 1)

head = """<!DOCTYPE html>
<html lang="en" class="h-full antialiased">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Marky — a fast, beautiful Markdown editor with live preview and automatic saving.">
  <meta name="theme-color" content="#7c3aed">
  <title>Marky — Markdown Editor</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="style.css">
  <script src="../vendor/tailwindcss.js"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
            display: ['"DM Sans"', 'Inter', 'system-ui', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
          },
        },
      },
    };
  </script>
  <link id="hljs-theme-light" rel="stylesheet" href="../vendor/github.min.css">
  <link id="hljs-theme-dark" rel="stylesheet" href="../vendor/github-dark.min.css" disabled>
  <script src="../vendor/highlight.min.js"></script>
  <script src="../vendor/marked.min.js"></script>
</head>
"""

www_index.write_text(head + body)
PY

echo "Synced web app to electron/www/ (app.js, filesystem.js, style.css, favicon.svg, index.html)"
