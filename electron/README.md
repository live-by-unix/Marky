# Marky Desktop (Electron)

Offline desktop build of Marky. All scripts and styles are bundled locally — no CDN required after setup.

## Requirements

- Node.js 18+
- npm

## Setup

From this folder (`electron/`):

```bash
npm install
npm run prepare
```

`prepare` syncs the web app from the project root into `www/` (including `index.html` with offline asset paths) and downloads vendor libraries into `vendor/`.

After **any** change to the root web app (`index.html`, `app.js`, `style.css`, `filesystem.js`), re-sync before running or packaging Electron:

```bash
npm run sync
```

## Run

```bash
npm start
```

## Project layout

| Path | Purpose |
|------|---------|
| `main.js` | Electron main process |
| `preload.js` | Secure bridge (`window.markyDesktop`) |
| `www/` | App shell + synced assets |
| `vendor/` | Offline copies of Tailwind, marked, Highlight.js |
| `scripts/` | Sync and vendor download helpers |

## Packaging (optional)

For distributable builds, add a packager such as `electron-builder` in a follow-up step. The current setup targets local offline development and personal use.

## Notes

- Data persists via IndexedDB inside Electron (same `MarkyDB` as the web app).
- External links open in the system browser.
- Re-run `npm run prepare` before packaging so `www/` and `vendor/` stay up to date.
