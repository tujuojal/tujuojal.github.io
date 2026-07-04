# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PowSurf is a static single-page web app — a snowboard slope finder — deployed to GitHub Pages. There is no build step, no npm, no node_modules. All libraries (Leaflet, MapLibre GL JS) are vendored directly in the repo as local files.

To run locally, serve the directory with any static server, e.g.:
```
python -m http.server 8080
```
Then open `http://localhost:8080`. Or just open `index.html` directly in a browser (some CORS-restricted features like NLS WCS won't work over `file://`).

Deployment is simply pushing to `main` — GitHub Pages auto-publishes from the repo root.

## Architecture

Everything lives in three files:

- **`index.html`** — app shell, all UI elements declared as static HTML
- **`app.js`** — all application logic (~1600 lines, no modules, `'use strict'`)
- **`styles.css`** — all styling, dark theme with CSS custom properties in `:root`

### State

A single `state` object at the top of `app.js` holds all runtime state: `slopeActive`, `minSlope`, `maxSlope`, `basemap`, `bearing`, `shadowActive`, `shadowDate`, `shadowSun`, `heatmapActive`.

### Map layers

Two map instances coexist:
- **`map`** (Leaflet) — 2D view, always initialised, hidden via CSS when 3D is active
- **`map3d`** (MapLibre GL JS) — 3D terrain view, lazy-initialised on first `btn-3d` click

The 2D map div is sized at 150% × 150% and CSS-rotated around its centre so rotation never exposes empty corners through `#app`'s `overflow: hidden`.

### Elevation and slope pipeline

`SlopeLayer` extends `L.GridLayer` and renders per-tile slope overlays on `<canvas>`. For each tile it:
1. Tries **NLS Finland WCS** (`fetchWcsDem`) — returns an ESRI ASCII Grid parsed by `parseAsciiGrid`, sampled with bilinear interpolation via `sampleGrid`. Finland extent only.
2. Falls back to **AWS Terrarium** RGB-encoded tiles (`fetchElevTile`) for global coverage.

Both paths compute slope via finite-difference gradient: `slope = atan(sqrt((dz/dx)² + (dz/dy)²))`.

NLS WCS coordinates require WGS84 → ETRS-TM35FIN conversion — this is implemented inline in `toTM35FIN()` (no external projection library).

Tile data is cached in two LRU-style `Map`s: `elevCache` (Terrarium RGBA arrays) and `wcsCache` (parsed ASCII grids), each capped at 256 entries.

### Shadow/hillshade

`ShadowLayer` also extends `L.GridLayer`. It fetches Terrarium tiles and calls `computeHillshade()`, which uses the sun vector from `state.shadowSun`. Sun position is computed by `sunPosition()` using simplified NOAA/Spencer equations (accuracy ~0.5° for 2000–2050).

In 3D mode, shadow is applied as MapLibre `setLight()` instead of a canvas overlay.

### Base maps

Nine tile sources are supported (NLS Finland, Kartverket Norway, GSI Japan, OpenTopoMap, CartoDB, OSM). Switching base maps in 3D destroys and recreates `map3d` to avoid MapLibre style-swap state issues.

### Cloudflare Worker proxy

A Cloudflare Worker at `powsurf-heatmap.powsurf-heatmap.workers.dev` proxies two things (both edge-cached 24 h):
- `/{z}/{x}/{y}.png` — Strava heatmap tiles with CORS headers added, so the 3D MapLibre view can drape them on terrain (Strava's CDN serves no CORS headers)
- `/nls/<path>` — NLS Finland WMTS + WCS requests, appending the API key server-side (stored as Worker secret `NLS_API_KEY`, never in this repo)

### Geolocation

GPS tracking uses `watchPosition`. Direction arrows are driven by `deviceorientationabsolute` (Chrome/Android) with fallback to `deviceorientation` + `webkitCompassHeading` (iOS). The 2D arrow is an SVG `<g>` rotated in place via `setAttribute('transform', ...)` rather than calling `setIcon()`. The 3D arrow is a `maplibregl.Marker` with an inline SVG element rotated via CSS.

iOS 13+ requires `DeviceOrientationEvent.requestPermission()` to be called **synchronously within the click handler** — this is why it happens before the async GPS call in the locate button handler.
