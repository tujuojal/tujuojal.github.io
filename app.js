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

// Norway / Scandinavia topographic tiles – free, CORS-enabled
// OpenTopoMap: OSM data + SRTM contours, CC-BY-SA
const NO_TOPO_URL   = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';
const NO_TOPO_ATTRIB = '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// CartoDB Positron: clean grayscale, CORS-enabled
const NO_GRAY_URL   = 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const NO_GRAY_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

// Kartverket (Norway) – official Norwegian mapping authority
// cache.kartverket.no v1 WMTS, CC BY 4.0.
// Path uses WMTS TileRow/TileCol order: {z}/{y}/{x}.
// Subdomains cache.kartverket.no, cache2.kartverket.no, cache3.kartverket.no.
const KARTVERKET_BASE  = 'https://cache{s}.kartverket.no/v1/wmts/1.0.0';
const KARTVERKET_ATTRIB = '&copy; <a href="https://www.kartverket.no">Kartverket</a> CC BY 4.0';
const KV_SUBDOMAINS = ['', '2', '3'];
const KV_TOPO_URL = `${KARTVERKET_BASE}/topo/default/webmercator/{z}/{y}/{x}.png`;
const KV_GRAY_URL = `${KARTVERKET_BASE}/topograatone/default/webmercator/{z}/{y}/{x}.png`;

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
  slopeActive:  false,
  minSlope:     15,
  maxSlope:     45,
  basemap:      'mml-topo',
  bearing:      0,       // map rotation, degrees clockwise from north (2D view only)
  shadowActive: false,
  shadowDate:   new Date(),
  shadowSun:    { azimuth: 180, altitude: 45 }, // updated by updateShadow()
};

/* ─── Map setup ─────────────────────────────────────────────────────── */

const map = L.map('map', {
  center: [64.5, 16.0],   // Centre of Scandinavia (covers Finland & Norway)
  zoom: 5,
  zoomControl: false,     // zoom +/- off: control would be in oversized div corner (off-screen)
  attributionControl: true,
});

/* ─── Tile layers ────────────────────────────────────────────────────── */

function mmlUrl(layer) {
  return `${MML_BASE}/${layer}/default/${MML_MATRIX}/{z}/{y}/{x}.png?api-key=${state.apiKey}`;
}

const layers = {
  'mml-topo': null,
  'mml-bg':   null,
  'no-topo':  L.tileLayer(NO_TOPO_URL, {
    maxZoom: 17,
    attribution: NO_TOPO_ATTRIB,
  }),
  'no-gray':  L.tileLayer(NO_GRAY_URL, {
    maxZoom: 19,
    attribution: NO_GRAY_ATTRIB,
  }),
  'kv-topo':  L.tileLayer(KV_TOPO_URL, {
    subdomains: KV_SUBDOMAINS,
    maxZoom: 18,
    attribution: KARTVERKET_ATTRIB,
  }),
  'kv-gray':  L.tileLayer(KV_GRAY_URL, {
    subdomains: KV_SUBDOMAINS,
    maxZoom: 18,
    attribution: KARTVERKET_ATTRIB,
  }),
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

  // Sync the 3D map's basemap tile source if it's already initialised
  if (map3d && map3d.isStyleLoaded()) {
    const src3d = map3d.getSource('basemap');
    if (src3d) src3d.setTiles(build3DStyle().sources.basemap.tiles);
  }
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

/* ─── Sun position ───────────────────────────────────────────────────── */

/**
 * Compute solar azimuth and altitude for a given moment and location.
 * Uses simplified NOAA / Spencer equations; accuracy ~0.5° for 2000–2050.
 *
 * @param {Date}   date   – any Date (UTC is extracted internally)
 * @param {number} latDeg – latitude  +N (degrees)
 * @param {number} lngDeg – longitude +E (degrees)
 * @returns {{ azimuth: number, altitude: number }}
 *   azimuth  – degrees from north, CW (0=N 90=E 180=S 270=W)
 *   altitude – degrees above horizon (negative = below horizon)
 */
function sunPosition(date, latDeg, lngDeg) {
  const D2R = Math.PI / 180;
  const JD  = date.getTime() / 86400000 + 2440587.5;  // Julian Date
  const n   = JD - 2451545.0;                          // days since J2000.0

  // Mean longitude and mean anomaly (degrees)
  const L0  = ((280.460  + 0.9856474 * n) % 360 + 360) % 360;
  const M   = ((357.528  + 0.9856003 * n) % 360 + 360) % 360;

  // Ecliptic longitude → right ascension + declination
  const lam = (L0 + 1.915 * Math.sin(M * D2R) + 0.020 * Math.sin(2 * M * D2R)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;                      // obliquity
  const RA  = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));

  // Greenwich Mean Sidereal Time → Local Hour Angle
  const GMST = ((280.46061837 + 360.98564736629 * n) % 360 + 360) % 360;
  let HA = (GMST + lngDeg - RA / D2R + 720) % 360;
  if (HA > 180) HA -= 360;                                          // [-180, 180]
  const HA_r = HA * D2R;

  const lat    = latDeg * D2R;
  const sinAlt = Math.sin(lat) * Math.sin(dec)
               + Math.cos(lat) * Math.cos(dec) * Math.cos(HA_r);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / D2R;

  const cosAlt = Math.cos(altitude * D2R);
  const cosAz  = cosAlt > 1e-8
    ? (Math.sin(dec) - Math.sin(lat) * sinAlt) / (cosAlt * Math.cos(lat))
    : 0;
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / D2R;
  if (HA_r > 0) azimuth = 360 - azimuth;  // afternoon: sun moves west

  return { azimuth, altitude };
}

/**
 * Compute a hillshade RGBA pixel array from a Terrarium elevation tile.
 * Shadow pixels are dark blue-grey; lit pixels are transparent.
 * Sun direction is read from state.shadowSun.
 *
 * Surface normal: cross(tangent_east, tangent_north) in (E, N, Up) = (-dz_east, dz_south, 1)
 */
function computeHillshade(data, mpp) {
  const { azimuth, altitude } = state.shadowSun;
  const D2R = Math.PI / 180;
  const az  = azimuth  * D2R;
  const alt = altitude * D2R;
  // Sun unit vector in (east, north, up)
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);

  // Decode all 256×256 elevations first (Terrarium: R*256 + G + B/256 - 32768)
  const elev = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const d = i << 2;
    elev[i] = data[d] * 256 + data[d + 1] + data[d + 2] / 256 - 32768;
  }

  const out   = new Uint8ClampedArray(65536 << 2);
  const night = lz <= 0;

  for (let y = 0; y < 256; y++) {
    const yN = y > 0   ? y - 1 : 0;
    const yS = y < 255 ? y + 1 : 255;
    for (let x = 0; x < 256; x++) {
      const xW = x > 0   ? x - 1 : 0;
      const xE = x < 255 ? x + 1 : 255;

      // Finite-difference gradient (dimensionless: metres elevation / metre horizontal)
      const dze = (elev[y  * 256 + xE] - elev[y  * 256 + xW]) / (2 * mpp);
      const dzs = (elev[yS * 256 + x ] - elev[yN * 256 + x ]) / (2 * mpp);

      // Normal = (-dze, dzs, 1) in (east, north, up); Lambertian dot product
      const len   = Math.sqrt(dze * dze + dzs * dzs + 1);
      const shade = Math.max(0, (-dze * lx + dzs * ly + lz) / len);

      // Transparent where lit, dark blue-grey where in shadow
      const a = night ? 210 : Math.round((1 - shade) * 190);
      const i = (y * 256 + x) << 2;
      out[i]     = 10;
      out[i + 1] = 15;
      out[i + 2] = 35;
      out[i + 3] = a;
    }
  }
  return out;
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

/* ─── Shadow (hillshade) layer ───────────────────────────────────────── */

const ShadowLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 256;
    const mpp = metersPerPixel(coords.z, coords);
    fetchElevTile(coords.x, coords.y, coords.z).then(data => {
      if (data) {
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(computeHillshade(data, mpp), 256, 256), 0, 0);
      }
      done(null, canvas);
    }).catch(() => done(null, canvas));
    return canvas;
  },
});

const shadowLayer = new ShadowLayer({
  opacity: 1,
  maxZoom: 18,
  pane:    'overlayPane',
  zIndex:  450,    // above slope overlay (400)
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

/**
 * Recompute sun position from state.shadowDate + current map centre, then
 * redraw the 2D hillshade overlay and/or update MapLibre 3D lighting.
 */
function updateShadow() {
  const c   = map.getCenter();
  const sun = sunPosition(state.shadowDate, c.lat, c.lng);
  state.shadowSun = sun;

  // Update the altitude badge in the shadow bar
  const altEl = document.getElementById('shadow-alt');
  if (altEl) {
    if (sun.altitude > 0) {
      altEl.textContent = `${Math.round(sun.altitude)}°`;
      altEl.className   = 'shadow-alt day';
    } else {
      altEl.textContent = 'night';
      altEl.className   = 'shadow-alt night';
    }
  }

  // Update MapLibre 3D lighting when 3D view is visible
  if (map3d && !map3dEl.classList.contains('hidden')) {
    try {
      map3d.setLight({
        anchor:    'map',
        position:  [1.5, sun.azimuth, Math.max(0, 90 - sun.altitude)],
        color:     sun.altitude > 0 ? '#ffffff' : '#334466',
        intensity: sun.altitude > 0 ? Math.min(1, sun.altitude / 45 + 0.3) : 0.1,
      });
    } catch { /* setLight signature differs across MapLibre versions */ }
  }

  // Redraw 2D hillshade when 2D view is visible
  if (state.shadowActive && map3dEl.classList.contains('hidden')) {
    shadowLayer.redraw();
  }
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

// Shadow overlay
const btnShadow     = document.getElementById('btn-shadow');
const shadowBarEl   = document.getElementById('shadow-bar');
const shadowDateEl  = document.getElementById('shadow-date');
const shadowTimeEl  = document.getElementById('shadow-time');
const shadowLabelEl = document.getElementById('shadow-time-label');

function _fmtTime(totalMin) {
  return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' +
         String(totalMin % 60).padStart(2, '0');
}

function _toDateInputVal(date) {
  return date.getFullYear() + '-' +
         String(date.getMonth() + 1).padStart(2, '0') + '-' +
         String(date.getDate()).padStart(2, '0');
}

function _applyShadowDateTime() {
  const mins  = parseInt(shadowTimeEl.value, 10);
  const parts = shadowDateEl.value.split('-').map(Number);
  if (parts.length === 3 && !parts.some(isNaN)) {
    state.shadowDate = new Date(parts[0], parts[1] - 1, parts[2],
                                Math.floor(mins / 60), mins % 60, 0, 0);
  }
  updateShadow();
}

let _shadowTimer = null;

btnShadow.addEventListener('click', () => {
  state.shadowActive = !state.shadowActive;
  btnShadow.classList.toggle('active', state.shadowActive);

  if (state.shadowActive) {
    // Initialise bar to current local time
    const now = new Date();
    state.shadowDate       = now;
    shadowDateEl.value     = _toDateInputVal(now);
    const nowMin           = now.getHours() * 60 + now.getMinutes();
    shadowTimeEl.value     = nowMin;
    shadowLabelEl.textContent = _fmtTime(nowMin);
    shadowBarEl.classList.remove('hidden');
    updateShadow();
    if (map3dEl.classList.contains('hidden')) shadowLayer.addTo(map);
  } else {
    shadowBarEl.classList.add('hidden');
    if (map.hasLayer(shadowLayer)) map.removeLayer(shadowLayer);
  }
});

// Update label immediately while dragging, debounce the expensive redraw
shadowTimeEl.addEventListener('input', () => {
  shadowLabelEl.textContent = _fmtTime(parseInt(shadowTimeEl.value, 10));
  clearTimeout(_shadowTimer);
  _shadowTimer = setTimeout(_applyShadowDateTime, 100);
});

shadowDateEl.addEventListener('change', _applyShadowDateTime);

// Keep sun position current as the user pans to new latitudes
map.on('moveend', () => {
  if (state.shadowActive) {
    const c = map.getCenter();
    state.shadowSun = sunPosition(state.shadowDate, c.lat, c.lng);
  }
});

// Geolocation + device heading
const btnLocate = document.getElementById('btn-locate');

/* SVG location marker: blue dot + directional arrow.
   Arrow is hidden by default and rotated via direct DOM setAttribute() so we
   never have to rebuild the Leaflet icon (avoids setIcon() overhead and any
   Leaflet icon-caching issues). */

const _LOC_MARKER_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="-40 -40 80 80">
  <g class="pows-direction-arrow" transform="rotate(0)" style="display:none">
    <path d="M0,-18 L-8,-36 L0,-44 L8,-36 Z"
          fill="#4fc3f7" fill-opacity="0.95"
          stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
  </g>
  <circle r="18" fill="#4fc3f7" fill-opacity="0.2"/>
  <circle r="9"  fill="#4fc3f7" stroke="white" stroke-width="3"/>
</svg>`;

const _staticLocIcon = L.divIcon({
  className: 'pows-loc-marker',
  html:      _LOC_MARKER_HTML,
  iconSize:  [80, 80],
  iconAnchor:[40, 40],
});

/** Rotate the 2D direction arrow to match current device heading on screen.
 *  mapEl is CSS-rotated by state.bearing, so the arrow element inherits that
 *  rotation.  We subtract it so the total visual angle equals _deviceHead. */
function _update2DArrow() {
  if (!_2dArrowEl) return;
  if (_deviceHead === null) { _2dArrowEl.style.display = 'none'; return; }
  const ang = ((_deviceHead - state.bearing) % 360 + 360) % 360;
  _2dArrowEl.setAttribute('transform', `rotate(${ang.toFixed(1)})`);
  _2dArrowEl.style.display = '';
}

let _locMarker    = null;   // L.marker for the dot + arrow  (2D)
let _locAccuracy  = null;   // L.circle for accuracy ring    (2D)
let _2dArrowEl    = null;   // direct ref to the arrow <g> inside the 2D SVG
let _3dArrowMarker = null;  // maplibregl.Marker for the 3D direction arrow
let _3dArrowEl    = null;   // arrow div element (for CSS rotation)
let _3dLocActive  = false;  // true when 3D GeoJSON layers are added to map3d
let _lastPos      = null;   // { lat, lng } – last GPS fix, used when switching views
let _watchId        = null;   // geolocation watchPosition id
let _orientHdlr     = null;   // absolute-event listener ref (stored for removeEventListener)
let _orientRelHdlr  = null;   // relative-event listener ref (fallback for iOS)
let _deviceHead   = null;   // current compass heading (degrees, or null)
let _trackingOn   = false;
let _firstFix     = true;

/* ─── 3D location indicator (GeoJSON circle layers + HTML Marker arrow) ─ */
// Dot/ring use WebGL circle layers (avoids terrain occlusion).
// Arrow uses a maplibregl.Marker with a custom SVG element (avoids addImage
// reliability issues in MapLibre 4.x) and is rotated via CSS transform.
const _3D_SRC   = 'pows-loc';
const _3D_RING  = 'pows-loc-ring';
const _3D_DOT   = 'pows-loc-dot';

/** Add GeoJSON source + circle layers and direction-arrow Marker to map3d. */
function _setup3DLocLayers() {
  if (!map3d || _3dLocActive) return;
  if (!map3d.isStyleLoaded()) return;  // defer until map 'load' fires

  map3d.addSource(_3D_SRC, {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
  });

  // Translucent accuracy halo
  map3d.addLayer({
    id: _3D_RING, type: 'circle', source: _3D_SRC,
    paint: {
      'circle-radius': 24,
      'circle-color': '#4fc3f7',
      'circle-opacity': 0.18,
      'circle-stroke-width': 0,
      'circle-pitch-alignment': 'viewport',
    },
  });

  // Solid location dot
  map3d.addLayer({
    id: _3D_DOT, type: 'circle', source: _3D_SRC,
    paint: {
      'circle-radius': 9,
      'circle-color': '#4fc3f7',
      'circle-opacity': 1,
      'circle-stroke-width': 3,
      'circle-stroke-color': 'white',
      'circle-pitch-alignment': 'viewport',
    },
  });

  _3dLocActive = true;

  // Direction arrow: HTML Marker with inline SVG, rotated via CSS transform.
  // This avoids all addImage/loadImage reliability issues in MapLibre 4.x.
  if (!_3dArrowMarker) {
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:none;opacity:0;transform-origin:center center;';
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="-16 -16 32 32">' +
      '<path d="M0,-13 L-7,9 L0,4 L7,9 Z" fill="#4fc3f7" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>' +
      '</svg>';
    _3dArrowEl = el;
    _3dArrowMarker = new maplibregl.Marker({ element: el, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat([_lastPos.lng, _lastPos.lat])
      .addTo(map3d);
    if (_deviceHead !== null) {
      const rot = ((_deviceHead - map3d.getBearing()) % 360 + 360) % 360;
      el.style.opacity = '1';
      el.style.transform = `rotate(${rot.toFixed(1)}deg)`;
    }
  }
}

/** Move the 3D dot to the current GPS position. */
function _update3DLocMarker() {
  if (!map3d || !_lastPos) return;
  if (!_3dLocActive) _setup3DLocLayers();
  if (!_3dLocActive) return;  // style not loaded yet – load handler will retry

  const src = map3d.getSource(_3D_SRC);
  if (!src) return;
  src.setData({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [_lastPos.lng, _lastPos.lat] },
    properties: {},
  });
  if (_3dArrowMarker) _3dArrowMarker.setLngLat([_lastPos.lng, _lastPos.lat]);
}

/** Remove 3D layers and source when leaving 3D view. */
function _remove3DLocMarker() {
  if (!map3d || !_3dLocActive) return;
  if (_3dArrowMarker) { _3dArrowMarker.remove(); _3dArrowMarker = null; }
  _3dArrowEl = null;
  [_3D_DOT, _3D_RING].forEach(id => {
    if (map3d.getLayer(id)) map3d.removeLayer(id);
  });
  if (map3d.getSource(_3D_SRC)) map3d.removeSource(_3D_SRC);
  _3dLocActive = false;
}

function _updateLocMarker(latlng, accuracy) {
  _lastPos = { lat: latlng[0], lng: latlng[1] };

  // 2D Leaflet marker (maintained even when the 2D map is hidden)
  if (!_locMarker) {
    _locAccuracy = L.circle(latlng, {
      radius: accuracy, color: '#4fc3f7', fillColor: '#4fc3f7',
      fillOpacity: 0.12, weight: 1, interactive: false,
    }).addTo(map);
    _locMarker = L.marker(latlng, {
      icon: _staticLocIcon, zIndexOffset: 1000, interactive: false,
    }).addTo(map);
    // Grab the arrow element directly – we rotate it in place rather than
    // calling setIcon(), which avoids any Leaflet icon-update quirks.
    const markerEl = _locMarker.getElement();
    _2dArrowEl = markerEl ? markerEl.querySelector('.pows-direction-arrow') : null;
    _update2DArrow();
  } else {
    _locMarker.setLatLng(latlng);
    _locAccuracy.setLatLng(latlng).setRadius(accuracy);
  }

  // 3D MapLibre marker (only when 3D view is visible)
  if (map3d && !map3dEl.classList.contains('hidden')) {
    _update3DLocMarker();
  }
}

function _startOrientTracking() {
  if (_orientHdlr) return;

  // Core handler: extracts heading and updates arrows (does NOT touch map bearing).
  const onHeading = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      h = e.webkitCompassHeading;               // iOS (already CW from North)
    } else if (typeof e.alpha === 'number' && e.alpha !== null) {
      h = (360 - e.alpha) % 360;               // Android: alpha is CCW, flip it
    }
    if (h === null) return;
    _deviceHead = h;

    if (map3d && !map3dEl.classList.contains('hidden')) {
      // ── 3D mode ───────────────────────────────────────────────────
      if (_3dLocActive && _3dArrowEl) {
        const rot = ((h - map3d.getBearing()) % 360 + 360) % 360;
        _3dArrowEl.style.opacity = '1';
        _3dArrowEl.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      }
    } else {
      // ── 2D mode ───────────────────────────────────────────────────
      _update2DArrow();
    }
  };

  // De-duplicate: prefer 'deviceorientationabsolute' (Chrome/Android, true north).
  // Fall back to 'deviceorientation' (iOS Safari, which provides webkitCompassHeading).
  // Registering both can cause double-firing with conflicting headings on some devices.
  let gotAbsolute = false;
  _orientHdlr    = e => { gotAbsolute = true; onHeading(e); };
  _orientRelHdlr = e => { if (!gotAbsolute) onHeading(e); };
  window.addEventListener('deviceorientationabsolute', _orientHdlr);
  window.addEventListener('deviceorientation',         _orientRelHdlr);
}

function _stopOrientTracking() {
  if (!_orientHdlr) return;
  window.removeEventListener('deviceorientationabsolute', _orientHdlr);
  window.removeEventListener('deviceorientation',         _orientRelHdlr);
  _orientHdlr    = null;
  _orientRelHdlr = null;
  _deviceHead    = null;
}

function _stopTracking() {
  if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
  _stopOrientTracking();
  if (_locMarker)   { map.removeLayer(_locMarker);   _locMarker   = null; }
  if (_locAccuracy) { map.removeLayer(_locAccuracy); _locAccuracy = null; }
  _2dArrowEl     = null;
  _remove3DLocMarker();
  _lastPos       = null;
  _trackingOn    = false;
  _firstFix      = true;
  btnLocate.classList.remove('active');
  btnLocate.style.opacity = '';
}

btnLocate.addEventListener('click', async () => {
  if (_trackingOn) { _stopTracking(); return; }

  if (!navigator.geolocation) {
    showToast('Geolocation not supported by this browser');
    return;
  }

  // ── iOS 13+ orientation permission ─────────────────────────────────
  // requestPermission() MUST be called synchronously within a user-gesture
  // handler (click/touch). Calling it later from an async GPS callback
  // makes iOS silently deny it, so we do it here first.
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') showToast('Motion access denied — direction arrow unavailable');
    } catch {
      showToast('Could not request motion permission');
    }
  }

  _trackingOn    = true;
  _firstFix      = true;
  btnLocate.classList.add('active');
  btnLocate.style.opacity = '0.6';

  // Start orientation tracking immediately (permission already resolved above)
  _startOrientTracking();

  _watchId = navigator.geolocation.watchPosition(
    pos => {
      btnLocate.style.opacity = '';
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      if (_firstFix) {
        _firstFix = false;
        map.setView(latlng, Math.max(map.getZoom(), 13));
        // Also pan the 3D map if it is currently visible
        if (map3d && !map3dEl.classList.contains('hidden')) {
          map3d.jumpTo({ center: [latlng[1], latlng[0]],
                         zoom: Math.max(map3d.getZoom(), 13) });
        }
      }
      _updateLocMarker(latlng, pos.coords.accuracy);
    },
    err => {
      showToast('Could not get location: ' + err.message);
      _stopTracking();
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
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

  // Load base map (prefer NLS topo if key exists, else Norway topo as a good free default)
  const initialBasemap = state.apiKey ? 'mml-topo' : 'no-topo';
  basemapSelect.value = initialBasemap;
  setBasemap(initialBasemap);

  updateZoomHint();
}

init();

/* ─── 2D map rotation (bearing) ─────────────────────────────────────── */

const mapEl        = document.getElementById('map');
const btnCompass   = document.getElementById('btn-compass');
const compassIcon  = btnCompass.querySelector('svg');

function setMapBearing(deg) {
  state.bearing = ((deg % 360) + 360) % 360;
  // Always keep translate(-50%,-50%) to maintain the oversized centred layout
  mapEl.style.transform = `translate(-50%, -50%) rotate(${state.bearing}deg)`;
  compassIcon.style.transform = `rotate(${state.bearing}deg)`;
  btnCompass.classList.toggle('active', state.bearing !== 0);
  // Re-sync the direction arrow when the user two-finger rotates the 2D map
  _update2DArrow();
}

btnCompass.addEventListener('click', () => setMapBearing(0));

// Two-finger rotation gesture on the 2D map
// Uses gesture-recognition: stay in "undecided" mode (Leaflet zoom works normally)
// until cumulative angle change exceeds ROTATION_ACTIVATE, then commit to rotation.
let _touchGesture = null; // { startAngle, prevAngle, mode: 'undecided'|'rotating' }
const ROTATION_ACTIVATE = 12; // degrees of cumulative angle change before rotation locks in

function _touchAngle(touches) {
  const dx = touches[1].clientX - touches[0].clientX;
  const dy = touches[1].clientY - touches[0].clientY;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

function _normDeg(d) {
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

mapEl.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    const a = _touchAngle(e.touches);
    _touchGesture = { startAngle: a, prevAngle: a, mode: 'undecided' };
  } else {
    _endTouchGesture();
  }
}, { passive: true });

mapEl.addEventListener('touchmove', e => {
  if (e.touches.length !== 2 || !_touchGesture) return;
  const angle = _touchAngle(e.touches);
  const g = _touchGesture;

  if (g.mode === 'undecided') {
    // Wait until cumulative rotation clearly exceeds threshold before committing
    if (Math.abs(_normDeg(angle - g.startAngle)) >= ROTATION_ACTIVATE) {
      g.mode = 'rotating';
      g.prevAngle = angle;    // reset incremental base so there's no snap
      map.touchZoom.disable(); // hand off gesture from Leaflet to us
    }
    return; // Leaflet handles zoom while undecided
  }

  // Rotation mode: incremental update each frame
  const delta = _normDeg(angle - g.prevAngle);
  g.prevAngle = angle;
  setMapBearing(state.bearing + delta * 0.75);
}, { passive: true });

function _endTouchGesture() {
  if (_touchGesture?.mode === 'rotating') map.touchZoom.enable();
  _touchGesture = null;
}
mapEl.addEventListener('touchend',    e => { if (e.touches.length < 2) _endTouchGesture(); }, { passive: true });
mapEl.addEventListener('touchcancel', _endTouchGesture, { passive: true });

/* ─── 3D terrain view (MapLibre GL JS) ──────────────────────────────── */

const map3dEl = document.getElementById('map-3d');
const btn3d   = document.getElementById('btn-3d');

let map3d      = null;
let terrain3d  = false;   // true once terrain source is loaded

/** Build a MapLibre style using the current basemap selection. */
function build3DStyle() {
  let tiles, attribution;
  if ((state.basemap === 'mml-topo' || state.basemap === 'mml-bg') && state.apiKey) {
    const layer = state.basemap === 'mml-topo' ? 'maastokartta' : 'taustakartta';
    tiles       = [`${MML_BASE}/${layer}/default/${MML_MATRIX}/{z}/{y}/{x}.png?api-key=${state.apiKey}`];
    attribution = '&copy; <a href="https://www.maanmittauslaitos.fi">Maanmittauslaitos</a>';
  } else if (state.basemap === 'no-topo' || state.basemap === 'kv-topo') {
    tiles       = [NO_TOPO_URL];
    attribution = NO_TOPO_ATTRIB;
  } else if (state.basemap === 'no-gray' || state.basemap === 'kv-gray') {
    tiles       = [NO_GRAY_URL];
    attribution = NO_GRAY_ATTRIB;
  } else {
    tiles       = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
    attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  }

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
    if (_trackingOn && _lastPos) _update3DLocMarker();
    // Keep the direction arrow aligned when user two-finger rotates the 3D map
    map3d.on('rotate', () => {
      if (_3dArrowEl && _deviceHead !== null) {
        const rot = ((_deviceHead - map3d.getBearing()) % 360 + 360) % 360;
        _3dArrowEl.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      }
    });
  });
}

btn3d.addEventListener('click', () => {
  const entering3D = mapEl.classList.contains('hidden') === false;

  if (entering3D) {
    // Switch 2D → 3D
    // Capture position before hiding the 2D map
    const c = map.getCenter();
    const z = map.getZoom();
    mapEl.classList.add('hidden');
    map3dEl.classList.remove('hidden');
    btn3d.classList.add('active');
    btn3d.setAttribute('aria-pressed', 'true');
    if (state.slopeActive)  showToast('Slope overlay is not shown in 3D view');
    if (state.shadowActive && map.hasLayer(shadowLayer)) map.removeLayer(shadowLayer);
    // Defer init/resize by one frame so the browser computes the container's
    // layout (clientWidth/clientHeight) before MapLibre reads it.
    requestAnimationFrame(() => {
      init3D();                        // first visit: MapLibre now sees correct size
      map3d.setCenter([c.lng, c.lat]);
      map3d.setZoom(z);
      map3d.resize();                  // repeat visits: re-measure container
      if (state.shadowActive) updateShadow();  // apply 3D sun lighting
      // Restore location marker in 3D (arrow rotation handled by next orientation event)
      if (_trackingOn && _lastPos) _update3DLocMarker();
    });
  } else {
    // Switch 3D → 2D; sync position back to Leaflet
    if (map3d) {
      const c = map3d.getCenter();
      map.setView([c.lat, c.lng], map3d.getZoom());
    }
    // Remove the 3D marker; the 2D marker is already on the hidden Leaflet map
    _remove3DLocMarker();
    // Restore 2D bearing from device heading if tracking
    if (_trackingOn && _deviceHead !== null) setMapBearing(_deviceHead);
    map3dEl.classList.add('hidden');
    mapEl.classList.remove('hidden');
    btn3d.classList.remove('active');
    btn3d.setAttribute('aria-pressed', 'false');
    if (state.shadowActive) {
      shadowLayer.addTo(map);
      updateShadow();
    }
  }
});
