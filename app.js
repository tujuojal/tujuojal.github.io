/**
 * PowSurf – Snowboard Slope Finder
 *
 * Base maps  : Maanmittauslaitos (NLS Finland) WMTS  /  OpenStreetMap fallback
 * Elevation  : NLS Finland WCS korkeusmalli_2m (2 m LiDAR DEM, requires API key)
 *              or AWS Terrain Tiles (Terrarium format) as free fallback
 * Slope calc : Per-tile canvas rendering using finite-difference gradient on DEM
 *
 * NLS API key: https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje
 */

'use strict';

/* ─── Leaflet availability guard ─────────────────────────────────────── */
if (typeof L === 'undefined') {
  const el = document.getElementById('map');
  if (el) {
    el.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0d1b2a';
    el.innerHTML = '<p style="color:#f0f4f8;font-family:sans-serif;text-align:center;padding:2rem">Failed to load map library.<br>Check your internet connection and reload.</p>';
  }
  throw new Error('Leaflet (L) is not defined — script loading failed');
}

/* ─── Constants ─────────────────────────────────────────────────────── */

// Correct NLS Finland hostname (avoin-karttakuva, not avoin-karttakuvapalvelu)
const MML_BASE   = 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0';
const MML_MATRIX = 'WGS84_Pseudo-Mercator';

// NLS Finland WCS – 2 m LiDAR elevation model, ETRS-TM35FIN (EPSG:3067)
// Requires API key.  SUBSET coords are easting/northing in metres.
const MML_WCS_BASE  = 'https://avoin-karttakuva.maanmittauslaitos.fi/ortokuvat-ja-korkeusmallit/wcs/v2';
const MML_COVERAGE  = 'korkeusmalli_2m';

// Mapzen/AWS Terrain tiles – Terrarium encoding, CORS enabled, free fallback
// elevation (m) = R*256 + G + B/256 - 32768
const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Minimum zoom at which slope calculation is meaningful
const MIN_SLOPE_ZOOM = 10;

// Simple LRU-style tile data cache (raw RGBA arrays)
const elevCache = new Map();
const wcsCache  = new Map();
const CACHE_MAX = 256;

/* ─── App state ─────────────────────────────────────────────────────── */

let _savedApiKey = '';
try { _savedApiKey = localStorage.getItem('mml_api_key') || ''; } catch {}

const state = {
  apiKey: _savedApiKey,
  slopeActive: false,
  minSlope: 15,
  maxSlope: 45,
  basemap: 'mml-topo',
};

/* ─── Map setup ─────────────────────────────────────────────────────── */

const map = L.map('map', {
  center: [65.0, 26.0],   // Centre of Finland
  zoom: 6,
  zoomControl: true,
  attributionControl: true,
});

// Move zoom control away from bottom-right (panel area on mobile)
map.zoomControl.setPosition('bottomleft');

/* ─── Tile layers ────────────────────────────────────────────────────── */

function mmlUrl(layer) {
  return `${MML_BASE}/${layer}/default/${MML_MATRIX}/{z}/{y}/{x}.png?api-key=${state.apiKey}`;
}

const layers = {
  'mml-topo': null,
  'mml-bg':   null,
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
};

function buildMmlLayer(layerName) {
  return L.tileLayer(mmlUrl(layerName), {
    maxZoom: 16,
    attribution: '&copy; <a href="https://www.maanmittauslaitos.fi">Maanmittauslaitos</a>',
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  });
}

/** Switch active base map.  If NLS layers need an API key, fall back to OSM. */
function setBasemap(key) {
  // Remove current layer
  Object.values(layers).forEach(l => l && map.hasLayer(l) && map.removeLayer(l));

  // Build NLS layers lazily (needs API key which may change)
  if (key === 'mml-topo' || key === 'mml-bg') {
    if (!state.apiKey) {
      showToast('Enter an NLS API key to use Maanmittauslaitos maps');
      // Fall through to OSM
      key = 'osm';
      document.getElementById('basemap-select').value = 'osm';
    } else {
      const layerName = key === 'mml-topo' ? 'maastokartta' : 'taustakartta';
      layers[key] = buildMmlLayer(layerName);
    }
  }

  state.basemap = key;
  layers[key].addTo(map);
  layers[key].bringToBack();
}

/* ─── WGS84 → ETRS-TM35FIN (EPSG:3067) projection ───────────────────── */
/**
 * Transverse Mercator projection onto ETRS-TM35FIN.
 * GRS80 ellipsoid, central meridian 27°E, k0=0.9996, false easting 500 000 m.
 * Accuracy: sub-metre over Finland. ETRS89 ≈ WGS84 for practical purposes.
 */
function toTM35FIN(lon, lat) {
  const a   = 6378137.0;
  const f   = 1 / 298.257222101;  // GRS80
  const e2  = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const k0  = 0.9996;
  const lon0 = 27 * Math.PI / 180;   // central meridian

  const phi  = lat * Math.PI / 180;
  const lam  = lon * Math.PI / 180 - lon0;
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const tanP = sinP / cosP;
  const N    = a / Math.sqrt(1 - e2 * sinP * sinP);
  const T    = tanP * tanP;
  const C    = ep2 * cosP * cosP;
  const A    = cosP * lam;
  const A2 = A * A, A3 = A2 * A, A4 = A3 * A, A5 = A4 * A, A6 = A5 * A;

  // Meridional arc
  const M = a * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi)
  );

  const E = 500000 + k0 * N * (A + (1 - T + C) * A3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A5 / 120);

  const Nval = k0 * (M + N * tanP * (A2 / 2
    + (5 - T + 9 * C + 4 * C * C) * A4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A6 / 720));

  return { E, N: Nval };
}

/** Convert slippy-map tile pixel to WGS84. */
function tilePixelToLatLon(tileX, tileY, z, px, py) {
  const n = Math.pow(2, z);
  const lon = (tileX + px / 256) / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + py / 256) / n)));
  return { lat: latRad * 180 / Math.PI, lon };
}

/** TM35FIN bounding box for a whole tile (NW + SE corners). */
function tileBoundsInTM35FIN(tileX, tileY, z) {
  const nw = tilePixelToLatLon(tileX, tileY, z, 0,   0);
  const se = tilePixelToLatLon(tileX, tileY, z, 256, 256);
  const pNW = toTM35FIN(nw.lon, nw.lat);
  const pSE = toTM35FIN(se.lon, se.lat);
  return {
    minE: Math.min(pNW.E, pSE.E),
    maxE: Math.max(pNW.E, pSE.E),
    minN: Math.min(pNW.N, pSE.N),
    maxN: Math.max(pNW.N, pSE.N),
  };
}

/* ─── NLS Finland WCS elevation (korkeusmalli_2m) ───────────────────── */
/**
 * Fetch a DEM patch for one tile from the NLS WCS service.
 * Returns { grid: Float32Array, nCols, nRows, xll, yll, cellSize }
 * or null on failure / no API key / outside Finland.
 *
 * The WCS returns an ESRI ASCII Grid.  We request a resolution matched to
 * the tile's pixel size (capped to the 2 m native resolution).
 *
 * Note: if the WCS endpoint blocks cross-origin requests, this will throw
 * and the caller silently falls back to the Terrarium tile source.
 */
async function fetchWcsDem(tileX, tileY, z) {
  if (!state.apiKey) return null;

  const bounds = tileBoundsInTM35FIN(tileX, tileY, z);

  // Rough check: Finland's TM35FIN extent
  if (bounds.maxE < -200000 || bounds.minE > 1500000 ||
      bounds.maxN < 6400000 || bounds.minN > 8400000) return null;

  // Pick a scale factor so we get ~256 output cells across the tile.
  // Native resolution = 2 m.  Valid scalefactors: 1, 0.5, 0.25, 0.125, 0.0625
  const mpp = metersPerPixel(z, { y: tileY });
  const desired = 2 / mpp;  // scalefactor needed for 2m→mpp
  const validSF = [1, 0.5, 0.25, 0.125, 0.0625];
  const sf = validSF.reduce((a, b) =>
    Math.abs(b - desired) < Math.abs(a - desired) ? b : a);

  const params = new URLSearchParams({
    service:     'WCS',
    version:     '2.0.1',
    request:     'GetCoverage',
    CoverageID:  MML_COVERAGE,
    format:      'text/plain',
    SCALEFACTOR: sf,
    'api-key':   state.apiKey,
  });
  // URLSearchParams.append preserves duplicate keys (required by WCS 2.0)
  params.append('SUBSET', `E(${Math.round(bounds.minE)},${Math.round(bounds.maxE)})`);
  params.append('SUBSET', `N(${Math.round(bounds.minN)},${Math.round(bounds.maxN)})`);

  const cacheKey = `wcs:${tileX}/${tileY}/${z}`;
  if (wcsCache.has(cacheKey)) return wcsCache.get(cacheKey);

  try {
    const res = await fetch(`${MML_WCS_BASE}?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const text = await res.text();
    const dem = parseAsciiGrid(text);
    if (wcsCache.size >= CACHE_MAX) wcsCache.delete(wcsCache.keys().next().value);
    wcsCache.set(cacheKey, dem);
    return dem;
  } catch {
    return null;
  }
}

function parseAsciiGrid(text) {
  const lines = text.trim().split('\n');
  const header = {};
  let dataStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length === 2 && isNaN(Number(parts[0]))) {
      header[parts[0].toLowerCase()] = Number(parts[1]);
      dataStart = i + 1;
    } else {
      break;
    }
  }

  const nCols   = header.ncols   || 0;
  const nRows   = header.nrows   || 0;
  const xll     = header.xllcorner !== undefined ? header.xllcorner : header.xllcenter;
  const yll     = header.yllcorner !== undefined ? header.yllcorner : header.yllcenter;
  const cs      = header.cellsize  || 2;
  const nodata  = header.nodata_value !== undefined ? header.nodata_value : -9999;

  const grid = new Float32Array(nCols * nRows);
  let idx = 0;

  for (let r = dataStart; r < lines.length && idx < grid.length; r++) {
    const vals = lines[r].trim().split(/\s+/);
    for (const v of vals) {
      const num = parseFloat(v);
      grid[idx++] = (num === nodata) ? 0 : num;
    }
  }

  return { grid, nCols, nRows, xll, yll, cellSize: cs };
}

/**
 * Bilinearly sample an ASCII grid at TM35FIN coordinates (E, N).
 * ESRI ASCII grid: row 0 = top (max northing), row nRows-1 = bottom (min northing).
 */
function sampleGrid(dem, E, N) {
  const { grid, nCols, nRows, xll, yll, cellSize } = dem;
  const col = (E - xll) / cellSize;
  const row = nRows - 1 - (N - yll) / cellSize;

  const c0 = Math.floor(col), c1 = c0 + 1;
  const r0 = Math.floor(row), r1 = r0 + 1;

  if (c0 < 0 || c1 >= nCols || r0 < 0 || r1 >= nRows) {
    const c = Math.max(0, Math.min(nCols - 1, Math.round(col)));
    const r = Math.max(0, Math.min(nRows - 1, Math.round(row)));
    return grid[r * nCols + c];
  }

  const fc = col - c0, fr = row - r0;
  return (
    grid[r0 * nCols + c0] * (1 - fc) * (1 - fr) +
    grid[r0 * nCols + c1] *      fc  * (1 - fr) +
    grid[r1 * nCols + c0] * (1 - fc) *      fr  +
    grid[r1 * nCols + c1] *      fc  *      fr
  );
}

/* ─── Slope canvas layer ─────────────────────────────────────────────── */

/**
 * SlopeLayer extends L.GridLayer to render per-tile slope overlays.
 *
 * Elevation source priority:
 *  1. NLS Finland WCS korkeusmalli_2m (2 m LiDAR, requires API key, Finland only)
 *  2. AWS Terrarium tiles (global, free, ~8–64 m depending on zoom)
 *
 * Slope algorithm: finite-difference gradient on the elevation grid.
 */
const SlopeLayer = L.GridLayer.extend({

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    const size = this.getTileSize();
    canvas.width  = size.x;
    canvas.height = size.y;

    this._renderSlopeTile(coords, canvas).then(() => done(null, canvas)).catch(err => {
      console.warn('Slope tile error', coords, err);
      done(err, canvas);
    });

    return canvas;
  },

  async _renderSlopeTile(coords, canvas) {
    const { x, y, z } = coords;
    const mpp = metersPerPixel(z, coords);

    // Try NLS WCS first, fall back to Terrarium
    const dem = await fetchWcsDem(x, y, z);

    if (dem) {
      await this._renderFromWcs(coords, canvas, dem, mpp);
    } else {
      await this._renderFromTerrarium(coords, canvas, mpp);
    }
  },

  /** Render slope from NLS WCS ASCII grid (per-pixel TM35FIN sampling). */
  async _renderFromWcs(coords, canvas, dem, mpp) {
    const { x, y, z } = coords;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    const d = imgData.data;
    const minS = state.minSlope;
    const maxS = state.maxSlope;

    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const { lat, lon } = tilePixelToLatLon(x, y, z, px + 0.5, py + 0.5);
        const { lat: latR, lon: lonR } = tilePixelToLatLon(x, y, z, px + 1.5, py + 0.5);
        const { lat: latB, lon: lonB } = tilePixelToLatLon(x, y, z, px + 0.5, py + 1.5);

        const p  = toTM35FIN(lon,  lat);
        const pR = toTM35FIN(lonR, latR);
        const pB = toTM35FIN(lonB, latB);

        const elev  = sampleGrid(dem, p.E,  p.N);
        const elevR = sampleGrid(dem, pR.E, pR.N);
        const elevB = sampleGrid(dem, pB.E, pB.N);

        const dzdx = (elevR - elev) / mpp;
        const dzdy = (elevB - elev) / mpp;
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);

        if (slope < minS || slope > maxS) continue;

        const color = slopeColor(slope);
        const i = (py * 256 + px) * 4;
        d[i] = color[0]; d[i+1] = color[1]; d[i+2] = color[2]; d[i+3] = color[3];
      }
    }

    ctx.putImageData(imgData, 0, 0);
  },

  /** Render slope from Terrarium tiles (neighbour tiles for edge gradients). */
  async _renderFromTerrarium(coords, canvas, mpp) {
    const { x, y, z } = coords;

    const [center, right, bottom] = await Promise.all([
      fetchElevTile(x,     y,     z),
      fetchElevTile(x + 1, y,     z),
      fetchElevTile(x,     y + 1, z),
    ]);

    if (!center) return;

    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(256, 256);
    const d = imgData.data;
    const minS = state.minSlope;
    const maxS = state.maxSlope;

    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const elev  = getElev(center, px, py);
        const elevR = px < 255 ? getElev(center, px + 1, py) : getElev(right,  0,  py);
        const elevB = py < 255 ? getElev(center, px, py + 1) : getElev(bottom, px, 0);

        const dzdx = (elevR - elev) / mpp;
        const dzdy = (elevB - elev) / mpp;
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);

        if (slope < minS || slope > maxS) continue;

        const color = slopeColor(slope);
        const i = (py * 256 + px) * 4;
        d[i] = color[0]; d[i+1] = color[1]; d[i+2] = color[2]; d[i+3] = color[3];
      }
    }

    ctx.putImageData(imgData, 0, 0);
  },
});

/** Map slope angle to RGBA colour */
function slopeColor(deg) {
  if (deg < 25) return [76,  175,  80, 204];   // green  – beginner    (--slope-a 0.80)
  if (deg < 30) return [255, 235,  59, 217];   // yellow – intermediate (--slope-b 0.85)
  if (deg < 38) return [255, 152,   0, 217];   // orange – advanced     (--slope-c 0.85)
  return              [244,  67,  54, 217];    // red    – expert       (--slope-d 0.85)
}

/** Metres per pixel at given zoom and tile row (accounts for latitude). */
function metersPerPixel(z, coords) {
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / Math.pow(2, z))));
  const lat = latRad * (180 / Math.PI);
  return (40075016.686 * Math.cos(lat * Math.PI / 180)) / (256 * Math.pow(2, z));
}

/* ─── Elevation tile fetching ────────────────────────────────────────── */

function terrariumUrl(x, y, z) {
  return TERRARIUM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** Returns raw RGBA Uint8ClampedArray for a Terrarium tile, cached. */
function fetchElevTile(x, y, z) {
  const key = `${z}/${x}/${y}`;
  if (elevCache.has(key)) return Promise.resolve(elevCache.get(key));

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0);
      const data = c.getImageData(0, 0, 256, 256).data;

      // Evict oldest entry when cache is full
      if (elevCache.size >= CACHE_MAX) {
        elevCache.delete(elevCache.keys().next().value);
      }
      elevCache.set(key, data);
      resolve(data);
    };

    img.onerror = () => {
      elevCache.set(key, null);
      resolve(null);
    };

    img.src = terrariumUrl(x, y, z);
  });
}

/** Decode Terrarium elevation from raw RGBA array. */
function getElev(data, px, py) {
  if (!data) return 0;
  const i = (py * 256 + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

/* ─── Slope layer instance ───────────────────────────────────────────── */

const slopeLayer = new SlopeLayer({
  opacity: 0.75,
  maxZoom: 18,
  pane: 'overlayPane',
  zIndex: 400,
});

/** Reload slope tiles when settings change (debounced). */
let redrawTimer = null;
function redrawSlope() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    if (state.slopeActive) {
      elevCache.clear();
      wcsCache.clear();
      slopeLayer.redraw();
    }
  }, 250);
}

/* ─── Loading state tracking ─────────────────────────────────────────── */

let pendingTiles = 0;
const loadingEl = document.getElementById('loading-indicator');

function startLoading() {
  pendingTiles++;
  loadingEl.classList.remove('hidden');
}

function stopLoading() {
  pendingTiles = Math.max(0, pendingTiles - 1);
  if (pendingTiles === 0) loadingEl.classList.add('hidden');
}

slopeLayer.on('tileloadstart', startLoading);
slopeLayer.on('tileload',      stopLoading);
slopeLayer.on('tileerror',     stopLoading);

/* ─── Zoom-level guard ───────────────────────────────────────────────── */

const zoomHint = document.getElementById('zoom-hint');

function updateZoomHint() {
  if (state.slopeActive && map.getZoom() < MIN_SLOPE_ZOOM) {
    zoomHint.classList.remove('hidden');
  } else {
    zoomHint.classList.add('hidden');
  }
}

map.on('zoomend', updateZoomHint);

/* ─── UI bindings ────────────────────────────────────────────────────── */

// Panel drag / tap to open-close
const panel    = document.getElementById('panel');
const panelDrag = document.getElementById('panel-drag');
const btnPanel  = document.getElementById('btn-panel');

let dragStartY = 0;
let panelOpen  = false;
let didDrag    = false;

function setPanelOpen(open) {
  panelOpen = open;
  panel.classList.toggle('panel-open',      open);
  panel.classList.toggle('panel-collapsed', !open);
}

panelDrag.addEventListener('click', () => {
  if (didDrag) { didDrag = false; return; }
  setPanelOpen(!panelOpen);
});
panelDrag.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setPanelOpen(!panelOpen);
  }
});
btnPanel.addEventListener('click',  () => setPanelOpen(!panelOpen));

// Touch drag on handle
panelDrag.addEventListener('touchstart', e => {
  dragStartY = e.touches[0].clientY;
  didDrag = false;
}, { passive: true });

panelDrag.addEventListener('touchend', e => {
  const dy = dragStartY - e.changedTouches[0].clientY;
  if (Math.abs(dy) > 20) {
    didDrag = true;
    setPanelOpen(dy > 0);
  }
}, { passive: true });

// Slope toggle
const toggleSlope  = document.getElementById('toggle-slope');
const slopeSection = document.getElementById('slope-controls');

toggleSlope.addEventListener('change', () => {
  state.slopeActive = toggleSlope.checked;
  slopeSection.classList.toggle('disabled', !state.slopeActive);

  if (state.slopeActive) {
    if (map.getZoom() >= MIN_SLOPE_ZOOM) {
      slopeLayer.addTo(map);
    } else {
      showToast('Zoom in to level ' + MIN_SLOPE_ZOOM + '+ to see slopes');
    }
  } else {
    slopeLayer.remove();
  }

  updateZoomHint();
});

// Auto-add slope layer when zooming in (if toggle is on)
map.on('zoomend', () => {
  if (state.slopeActive) {
    if (map.getZoom() >= MIN_SLOPE_ZOOM && !map.hasLayer(slopeLayer)) {
      slopeLayer.addTo(map);
    }
  }
  updateZoomHint();
});

// Range sliders
const minSliderEl = document.getElementById('min-slope');
const maxSliderEl = document.getElementById('max-slope');
const rangeDisplay = document.getElementById('slope-range-display');
const rangeFill = document.getElementById('range-fill');

function updateRangeUI() {
  const min = parseInt(minSliderEl.value, 10);
  const max = parseInt(maxSliderEl.value, 10);
  const pctMin = (min / 60) * 100;
  const pctMax = (max / 60) * 100;

  rangeFill.style.left  = pctMin + '%';
  rangeFill.style.width = Math.max(0, pctMax - pctMin) + '%';
  rangeDisplay.textContent = `${min}° – ${max}°`;
}

minSliderEl.addEventListener('input', () => {
  let min = parseInt(minSliderEl.value, 10);
  const max = parseInt(maxSliderEl.value, 10);
  if (min >= max) { min = max - 1; minSliderEl.value = min; }
  state.minSlope = min;
  updateRangeUI();
  redrawSlope();
});

maxSliderEl.addEventListener('input', () => {
  const min = parseInt(minSliderEl.value, 10);
  let max = parseInt(maxSliderEl.value, 10);
  if (max <= min) { max = min + 1; maxSliderEl.value = max; }
  state.maxSlope = max;
  updateRangeUI();
  redrawSlope();
});

updateRangeUI();

// Base map selector
const basemapSelect = document.getElementById('basemap-select');
basemapSelect.addEventListener('change', () => {
  setBasemap(basemapSelect.value);
});

// API key
const apiKeyInput  = document.getElementById('api-key-input');
const btnSaveKey   = document.getElementById('btn-save-key');
const apiStatus    = document.getElementById('api-status');

function applyApiKey(key) {
  state.apiKey = key.trim();
  try { localStorage.setItem('mml_api_key', state.apiKey); } catch {}

  if (state.apiKey) {
    apiStatus.textContent = 'Set';
    apiStatus.className   = 'api-badge api-set';
    // Rebuild NLS layers with new key and switch to NLS topo
    layers['mml-topo'] = null;
    layers['mml-bg']   = null;
    setBasemap('mml-topo');
    basemapSelect.value = 'mml-topo';
    wcsCache.clear();
    if (state.slopeActive) redrawSlope();
    showToast('API key saved — NLS maps and 2 m DEM activated.');
  } else {
    apiStatus.textContent = 'Not set';
    apiStatus.className   = 'api-badge api-none';
  }
}

btnSaveKey.addEventListener('click', () => applyApiKey(apiKeyInput.value));
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyApiKey(apiKeyInput.value); });

// Geolocation
const btnLocate = document.getElementById('btn-locate');

btnLocate.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported by this browser');
    return;
  }
  btnLocate.style.opacity = '0.5';
  navigator.geolocation.getCurrentPosition(
    pos => {
      btnLocate.style.opacity = '';
      map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 13));
    },
    err => {
      btnLocate.style.opacity = '';
      showToast('Could not get location: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

/* ─── Tap to inspect slope ───────────────────────────────────────────── */

const slopeTip = document.getElementById('slope-tip');
let tipTimer = null;

map.on('click', async e => {
  if (!state.slopeActive || map.getZoom() < MIN_SLOPE_ZOOM) return;

  const z = map.getZoom();
  const point = map.project(e.latlng, z);
  const tileX = Math.floor(point.x / 256);
  const tileY = Math.floor(point.y / 256);
  const px    = Math.floor(point.x % 256);
  const py    = Math.floor(point.y % 256);

  const mpp = metersPerPixel(z, { y: tileY });
  let slope = 0;

  const dem = await fetchWcsDem(tileX, tileY, z);
  if (dem) {
    const p  = toTM35FIN(e.latlng.lng, e.latlng.lat);
    const { lat: latR, lon: lonR } = tilePixelToLatLon(tileX, tileY, z, px + 1.5, py + 0.5);
    const { lat: latB, lon: lonB } = tilePixelToLatLon(tileX, tileY, z, px + 0.5, py + 1.5);
    const pR = toTM35FIN(lonR, latR);
    const pB = toTM35FIN(lonB, latB);
    const elev = sampleGrid(dem, p.E, p.N);
    const elevR = sampleGrid(dem, pR.E, pR.N);
    const elevB = sampleGrid(dem, pB.E, pB.N);
    slope = Math.atan(Math.sqrt(
      Math.pow((elevR - elev) / mpp, 2) + Math.pow((elevB - elev) / mpp, 2)
    )) * (180 / Math.PI);
  } else {
    const [center, right, bottom] = await Promise.all([
      fetchElevTile(tileX,     tileY,     z),
      fetchElevTile(tileX + 1, tileY,     z),
      fetchElevTile(tileX,     tileY + 1, z),
    ]);

    if (!center) return;

    const elev  = getElev(center, px, py);
    const elevR = px < 255 ? getElev(center, px + 1, py) : getElev(right, 0, py);
    const elevB = py < 255 ? getElev(center, px, py + 1) : getElev(bottom, px, 0);
    slope = Math.atan(Math.sqrt(
      Math.pow((elevR - elev) / mpp, 2) + Math.pow((elevB - elev) / mpp, 2)
    )) * (180 / Math.PI);
  }

  const src = dem ? 'NLS 2 m DEM' : 'Global DEM';
  const containerPt = map.latLngToContainerPoint(e.latlng);

  slopeTip.textContent = `${slope.toFixed(1)}°  –  ${slopeLabel(slope)}  (${src})`;
  slopeTip.style.left  = containerPt.x + 'px';
  slopeTip.style.top   = containerPt.y + 'px';
  slopeTip.classList.remove('hidden');

  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => slopeTip.classList.add('hidden'), 3000);
});

function slopeLabel(deg) {
  if (deg < 10)  return 'Flat';
  if (deg < 15)  return 'Gentle';
  if (deg < 25)  return 'Beginner';
  if (deg < 30)  return 'Intermediate';
  if (deg < 38)  return 'Advanced';
  if (deg < 45)  return 'Expert';
  return 'Extreme';
}

/* ─── Toast notification ─────────────────────────────────────────────── */

let toastEl = null;
let toastTimer = null;

function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = [
      'position:fixed', 'bottom:120px', 'left:50%', 'transform:translateX(-50%)',
      'background:rgba(13,27,42,0.92)', 'color:#f0f4f8',
      'padding:10px 18px', 'border-radius:20px',
      'font-size:14px', 'z-index:1000',
      'border:1px solid rgba(255,255,255,0.1)',
      'backdrop-filter:blur(8px)',
      'pointer-events:none',
      'white-space:nowrap',
      'max-width:90vw', 'text-align:center',
    ].join(';');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3500);
}

/* ─── Initialise ─────────────────────────────────────────────────────── */

function init() {
  // Restore saved API key to input
  if (state.apiKey) {
    apiKeyInput.value     = state.apiKey;
    apiStatus.textContent = 'Set';
    apiStatus.className   = 'api-badge api-set';
  }

  // Load base map (prefer NLS topo if key exists, else OSM)
  const initialBasemap = state.apiKey ? 'mml-topo' : 'osm';
  basemapSelect.value = initialBasemap;
  setBasemap(initialBasemap);

  updateZoomHint();
}

init();

/* ─── 3D terrain view (MapLibre GL JS) ──────────────────────────────── */

const btn3d   = document.getElementById('btn-3d');
const mapEl   = document.getElementById('map');
const map3dEl = document.getElementById('map-3d');

let map3d      = null;
let terrain3d  = false;   // true once terrain source is loaded

/** Build a MapLibre style using the current basemap selection. */
function build3DStyle() {
  // Use NLS tiles if key is set, otherwise OSM
  const tiles = state.apiKey
    ? [`${MML_BASE}/maastokartta/default/${MML_MATRIX}/{z}/{y}/{x}.png?api-key=${state.apiKey}`]
    : ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
  const attribution = state.apiKey
    ? '&copy; <a href="https://www.maanmittauslaitos.fi">Maanmittauslaitos</a>'
    : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  return {
    version: 8,
    sources: {
      basemap: { type: 'raster', tiles, tileSize: 256, attribution },
      'terrain-dem': {
        type: 'raster-dem',
        tiles: [TERRARIUM_URL],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 14,
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

function init3D() {
  if (map3d) return;

  const center = map.getCenter();

  map3d = new maplibregl.Map({
    container: 'map-3d',
    style: build3DStyle(),
    center: [center.lng, center.lat],
    zoom:   map.getZoom(),
    pitch:  50,
    bearing: 0,
    maxPitch: 85,
  });

  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
  map3d.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  // Enable terrain elevation once the style has loaded
  map3d.on('load', () => {
    map3d.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
    terrain3d = true;
  });
}

btn3d.addEventListener('click', () => {
  const entering3D = mapEl.classList.contains('hidden') === false;

  if (entering3D) {
    // Switch 2D → 3D
    init3D();
    const c = map.getCenter();
    map3d.setCenter([c.lng, c.lat]);
    map3d.setZoom(map.getZoom());
    mapEl.classList.add('hidden');
    map3dEl.classList.remove('hidden');
    btn3d.classList.add('active');
    btn3d.setAttribute('aria-pressed', 'true');
    if (state.slopeActive) showToast('Slope overlay is not shown in 3D view');
  } else {
    // Switch 3D → 2D; sync position back to Leaflet
    if (map3d) {
      const c = map3d.getCenter();
      map.setView([c.lat, c.lng], map3d.getZoom());
    }
    map3dEl.classList.add('hidden');
    mapEl.classList.remove('hidden');
    btn3d.classList.remove('active');
    btn3d.setAttribute('aria-pressed', 'false');
  }
});
