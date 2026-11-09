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

### Sun shadows

`sunPosition()` gives the sun's azimuth and **apparent** altitude (simplified NOAA/Spencer equations, ~0.5° for 2000–2050, plus `refraction()` — matters for low Nordic winter sun).

`ShadowLayer` (2D only) shades real terrain shadows, not just slope orientation. For each tile `renderShadowTile()` builds two elevation mosaics in global Web-Mercator pixel space and hands them to `computeShadow()` in **`shadow-worker.js`** (worker pool; the same file is also loaded as a page script as a main-thread fallback):
- **near** — the tile plus its sun-side neighbours at the same zoom, from `fetchBestElevGrid()`;
- **far** — Terrarium `SHADOW_FAR_DZ` zooms coarser, sun-side half of 5×5 tiles, so ridges 10–30 km away still cast shadows when the sun is low.

`computeShadow()` marks a pixel shaded if it faces away from the sun or if a ray marched toward the sun hits terrain (with earth curvature + refraction). Distant steps test block maxima from a max-pyramid so ridges can't be skipped, then `refineHit()` re-checks hits at finer levels so edges stay sharp. Rays are traced on every other pixel and in between only along shadow edges. Changing the time calls `shadowLayer.refresh()`, which re-shades tiles in place; panning only refreshes if the sun moved > 0.2°.

`fetchBestElevGrid()` resamples every source onto map-tile pixels (256² Float32Array, NaN = no data), preferring, at zoom ≥ `ELEV_HIRES_MIN_ZOOM`:
1. **Kartverket** 1 m DTM (`fetchKartverketGrid`) — Norway; WCS at `wcs.geonorge.no`, CORS-enabled, no key. Requested in EPSG:4326 with bilinear interpolation (nearest-neighbour aliases into noise), returned as uncompressed float32 GeoTIFF read by `parseFloatTiff()`. Outside Norway it returns exactly 0 / sparse tiles → treated as no data.
2. **NLS** 2 m DTM (`fetchNlsGrid`, via `fetchWcsDem`) — Finland.
3. **Terrarium** (`fetchTerrariumGrid`) — global; above z15 upsampled from the z15 parent (Terrarium has no z16+).

Grids are cached in `gridCache`, and concurrent requests for the same grid share one fetch (`_once`). A grid built after a *transient* high-res failure (timeout/5xx — `fetchKartverketGrid`/`fetchWcsDem` return `undefined` for these, `null` for "no data here") is marked `complete: false`, not cached, and the tile re-shades itself a few seconds later (`ShadowLayer._shade`).

**Datum offset:** Terrarium heights differ from the national models (≈ −20…−26 m NLS − Terrarium around Pyhätunturi, a few m in Norway). `_datumOffset()` measures the median difference per high-res tile, and `renderShadowTile()` shifts all Terrarium terrain in the mosaics (far field, fallback neighbours) by it — otherwise every Terrarium/high-res seam is a cliff that throws long false shadows at low sun.

**NLS ASCII grids:** with `SCALEFACTOR` < 1 the cells come back slightly non-square and GDAL writes `dx`/`dy` instead of `cellsize` — `parseAsciiGrid()` handles both (`cellX`/`cellY`). `sampleGrid()` returns NaN more than one cell outside the grid instead of smearing edge values. NLS requests run at most `WCS_MAX_PARALLEL` at a time (`_wcsRequest`), with one retry.

In 3D mode, shadow is applied as MapLibre `setLight()`, which in practice has no visible effect on terrain (MapLibre lights only fill-extrusions).

### Base maps

Nine tile sources are supported (NLS Finland, Kartverket Norway, GSI Japan, OpenTopoMap, CartoDB, OSM). Switching base maps in 3D destroys and recreates `map3d` to avoid MapLibre style-swap state issues.

### Cloudflare Worker proxy

A Cloudflare Worker at `powsurf-heatmap.powsurf-heatmap.workers.dev` proxies two things (both edge-cached 24 h):
- `/{z}/{x}/{y}.png` — Strava heatmap tiles with CORS headers added, so the 3D MapLibre view can drape them on terrain (Strava's CDN serves no CORS headers)
- `/nls/<path>` — NLS Finland WMTS + WCS requests, appending the API key server-side (stored as Worker secret `NLS_API_KEY`, never in this repo)

### Geolocation

GPS tracking uses `watchPosition`. Direction arrows are driven by `deviceorientationabsolute` (Chrome/Android) with fallback to `deviceorientation` + `webkitCompassHeading` (iOS). The 2D arrow is an SVG `<g>` rotated in place via `setAttribute('transform', ...)` rather than calling `setIcon()`. The 3D arrow is a `maplibregl.Marker` with an inline SVG element rotated via CSS.

iOS 13+ requires `DeviceOrientationEvent.requestPermission()` to be called **synchronously within the click handler** — this is why it happens before the async GPS call in the locate button handler.

### Place search

The 🔍 button opens `#search-bar`, which geocodes with OpenStreetMap **Nominatim** (`NOMINATIM_URL`). Nominatim's usage policy allows ≤1 request/s and forbids search-as-you-type, so queries only run on submit and are spaced by `SEARCH_MIN_GAP_MS`. Results are biased toward the current view (`viewbox`). Input like `68.06, 24.06` is parsed locally by `parseLatLng()` and never hits the network. Picking a result moves whichever map is visible and drops a pin (tap the pin to remove it); `_syncSearchPin3D()` must be called after every `init3D()` because basemap switches recreate `map3d`.
