#!/usr/bin/env node
/**
 * PowSurf regression test suite.
 * Run with: node test.js
 * Tests what can be verified statically (syntax, structure, URLs, wiring).
 * Browser-only features (map rendering, GPS, orientation) require manual testing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = __dirname;
const appSrc    = fs.readFileSync(path.join(ROOT, 'app.js'),    'utf8');
const indexSrc  = fs.readFileSync(path.join(ROOT, 'index.html'),'utf8');
const stylesSrc = fs.readFileSync(path.join(ROOT, 'styles.css'),'utf8');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.error(`  ✗  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

/* ─── 1. Syntax check ─────────────────────────────────────────────────── */
console.log('\n── 1. Syntax ──');

function syntaxOk(file, src) {
  // Use node's parser via vm module (CommonJS only, no ES module keyword issues)
  // We strip 'use strict' and wrap in a function so top-level `const` doesn't
  // collide — we only care about parse errors, not runtime errors.
  const vm = require('vm');
  try {
    new vm.Script(src);
    ok(`${file} parses without errors`, true);
  } catch (e) {
    ok(`${file} parses without errors`, false, e.message);
  }
}

syntaxOk('app.js', appSrc);

/* ─── 2. Duplicate const declarations ────────────────────────────────── */
console.log('\n── 2. Duplicate const/let/var declarations ──');

const constDecls = [...appSrc.matchAll(/^(?:const|let|var)\s+(\w+)\s*=/gm)]
  .map(m => m[1]);
const seen = {};
const dupes = [];
for (const name of constDecls) {
  if (seen[name]) dupes.push(name);
  seen[name] = true;
}
ok('No duplicate top-level declarations', dupes.length === 0,
   dupes.length ? 'Duplicates: ' + dupes.join(', ') : '');

/* ─── 3. Required constants / URLs ───────────────────────────────────── */
console.log('\n── 3. Required URL constants ──');

const requiredConsts = [
  'NVE_BRATTHET_UTLOP_URL',
  'GSI_SLOPE_URL',
  'GSI_HAZARD_URL',
  'GSI_ATTRIB',
  'NVE_ATTRIB',
];
for (const c of requiredConsts) {
  ok(`${c} is declared`, appSrc.includes(`const ${c}`) || appSrc.includes(`let ${c}`));
}

// URL format checks
ok('NVE URL uses ArcGIS tile order {z}/{y}/{x}',
   appSrc.includes('{z}/{y}/{x}') && appSrc.includes('gis3.nve.no'));
ok('GSI slope URL uses standard XYZ {z}/{x}/{y}',
   appSrc.includes('slopezone1map/{z}/{x}/{y}'));
ok('GSI hazard URL uses standard XYZ {z}/{x}/{y}',
   appSrc.includes('nadarekikenkasyo/{z}/{x}/{y}'));

/* ─── 4. State object fields ──────────────────────────────────────────── */
console.log('\n── 4. State fields ──');

const stateFields = [
  'slopeActive', 'avalancheActive', 'jpAvalancheActive',
  'shadowActive', 'basemap', 'bearing',
];
for (const f of stateFields) {
  ok(`state.${f} is declared`, appSrc.includes(`${f}:`));
}

/* ─── 5. Toggle wiring ────────────────────────────────────────────────── */
console.log('\n── 5. Toggle wiring ──');

ok('toggle-avalanche element exists in HTML',
   indexSrc.includes('id="toggle-avalanche"'));
ok('toggle-jp-avalanche element exists in HTML',
   indexSrc.includes('id="toggle-jp-avalanche"'));
ok('toggle-slope element exists in HTML',
   indexSrc.includes('id="toggle-slope"'));
ok('toggleAvalanche addEventListener in app.js',
   appSrc.includes("getElementById('toggle-avalanche')"));
ok('toggleJpAvalanche addEventListener in app.js',
   appSrc.includes("getElementById('toggle-jp-avalanche')"));

/* ─── 6. _applyAvalancheLayers uses avalancheLayer (not old _avalancheLayers) */
console.log('\n── 6. Avalanche layer apply functions ──');

ok('_avalancheLayers (removed array) is not referenced',
   !appSrc.includes('_avalancheLayers.forEach'));
ok('_applyAvalancheLayers is defined',
   appSrc.includes('function _applyAvalancheLayers'));
ok('_applyJpAvalancheLayers is defined',
   appSrc.includes('function _applyJpAvalancheLayers'));
ok('_applyJpAvalancheLayers called on 3D→2D transition',
   appSrc.includes('_applyJpAvalancheLayers()'));
ok('_apply3DAvalancheLayers is defined',
   appSrc.includes('function _apply3DAvalancheLayers'));
ok('_apply3DAvalancheLayers called from _applyAvalancheLayers',
   appSrc.includes('_apply3DAvalancheLayers()'));

/* ─── 7. 3D/2D transition cleanup ─────────────────────────────────────── */
console.log('\n── 7. 3D transition layer cleanup ──');

ok('Norway avalanche layer managed in 2D (add/remove)',
   appSrc.includes('map.removeLayer(avalancheLayer)'));
ok('Japan slope layer managed in 2D (add/remove)',
   appSrc.includes('map.removeLayer(jpSlopeLayer)'));
ok('Japan hazard layer managed in 2D (add/remove)',
   appSrc.includes('map.removeLayer(jpHazardLayer)'));
ok('Norway avalanche layer restored on 3D→2D',
   appSrc.includes('_applyAvalancheLayers()'));
ok('3D avalanche overlay sources in build3DStyle',
   appSrc.includes("'aval-nve'") && appSrc.includes("'aval-jp-slope'") && appSrc.includes("'aval-jp-hazard'"));
ok('3D avalanche visibility toggled via setLayoutProperty',
   appSrc.includes("setLayoutProperty('aval-nve'"));
ok('_apply3DAvalancheLayers called on map3d load',
   appSrc.includes('_apply3DAvalancheLayers()'));
ok('slope-3d source in build3DStyle',
   appSrc.includes("'slope-3d'"));
ok('slope protocol registered (_registerSlopeProtocol)',
   appSrc.includes('_registerSlopeProtocol'));
ok('_apply3DSlopeLayer is defined',
   appSrc.includes('function _apply3DSlopeLayer'));
ok('_refresh3DSlopeSource is defined',
   appSrc.includes('function _refresh3DSlopeSource'));
ok('_refresh3DSlopeSource called from redrawSlope',
   appSrc.includes('_refresh3DSlopeSource()'));
ok('_apply3DSlopeLayer called from toggleSlope handler',
   appSrc.includes('_apply3DSlopeLayer()'));
ok('_apply3DSlopeLayer called on map3d load',
   appSrc.includes('_apply3DSlopeLayer()'));
ok('No slope-only 3D toast remaining',
   !appSrc.includes("'Slope overlay is not shown in 3D view'"));
ok('Terrain in initial 3D style (not via setTerrain after load)',
   appSrc.includes("terrain: { source: 'terrain-dem'") && !appSrc.includes('map3d.setTerrain('));

/* ─── 8. Location / direction arrow ──────────────────────────────────── */
console.log('\n── 8. Location & direction arrow ──');

ok('_gpsHead variable declared',
   appSrc.includes('let _gpsHead'));
ok('_deviceHead variable declared',
   appSrc.includes('let _deviceHead'));
ok('GPS course heading fallback: pos.coords.heading read',
   appSrc.includes('pos.coords.heading'));
ok('_gpsHead cleared in _stopTracking',
   appSrc.includes('_gpsHead       = null') || appSrc.includes('_gpsHead = null'));
ok('_update2DArrow uses _deviceHead ?? _gpsHead',
   appSrc.includes('_deviceHead ?? _gpsHead'));
ok('3D arrow uses inner element (not outer marker div)',
   appSrc.includes('_3dArrowEl = inner'));
ok('Geolocation permission-denied gives clear message',
   appSrc.includes('Location access denied'));

/* ─── 9. HTML structure ───────────────────────────────────────────────── */
console.log('\n── 9. HTML structure ──');

ok('Map div present',             indexSrc.includes('id="map"'));
ok('3D map div present',          indexSrc.includes('id="map-3d"'));
ok('Panel div present',           indexSrc.includes('id="panel"'));
ok('Slope tip div present',       indexSrc.includes('id="slope-tip"'));
ok('Shadow bar div present',      indexSrc.includes('id="shadow-bar"'));
ok('app.js script tag present',   indexSrc.includes('src="app.js"'));
ok('leaflet.js script tag present', indexSrc.includes('src="leaflet.js"'));
ok('No SVG filter block (removed)', !indexSrc.includes('id="pows-svg-filters"'));

/* ─── 9b. Place search ───────────────────────────────────────────────── */
console.log('\n── 9b. Place search ──');

ok('Search button present',        indexSrc.includes('id="btn-search"'));
ok('Search bar present',           indexSrc.includes('id="search-bar"'));
ok('Search uses Nominatim',        appSrc.includes('nominatim.openstreetmap.org/search'));
ok('Search respects 1 req/s limit', /SEARCH_MIN_GAP_MS\s*=\s*1\d{3}/.test(appSrc));
ok('Search pin rebuilt after every init3D()',
   (appSrc.match(/_syncSearchPin3D\(\);/g) || []).length >= 3);
ok('Search pin styled',            stylesSrc.includes('.search-pin'));

{
  const src = appSrc.match(/function parseLatLng\(text\) \{[\s\S]*?\n\}/);
  ok('parseLatLng declared', !!src);
  if (src) {
    const parseLatLng = new Function(src[0] + '; return parseLatLng;')();
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('parseLatLng "68.06, 24.06"', eq(parseLatLng('68.06, 24.06'), { lat: 68.06, lng: 24.06 }));
    ok('parseLatLng "68.06 24.06"',  eq(parseLatLng(' 68.06 24.06 '), { lat: 68.06, lng: 24.06 }));
    ok('parseLatLng "-33.9,18.4"',   eq(parseLatLng('-33.9,18.4'), { lat: -33.9, lng: 18.4 }));
    ok('parseLatLng rejects place names', parseLatLng('Pallas') === null);
    ok('parseLatLng rejects out-of-range', parseLatLng('95, 10') === null);
  }
}

/* ─── 9c. Terrain shadows ─────────────────────────────────────────────── */
console.log('\n── 9c. Terrain shadows ──');

ok('shadow-worker.js loaded before app.js',
   indexSrc.indexOf('src="shadow-worker.js"') > -1 &&
   indexSrc.indexOf('src="shadow-worker.js"') < indexSrc.indexOf('src="app.js"'));
{
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok('shadow-worker.js in service worker shell', swSrc.includes("'shadow-worker.js'"));
  ok('Kartverket WCS cached by service worker', swSrc.includes('wcs\\\\.geonorge\\\\.no'));
}
ok('Kartverket DTM is a shadow elevation source', appSrc.includes('wcs.geonorge.no') && appSrc.includes('fetchKartverketGrid'));
ok('Kartverket requested with bilinear interpolation', /interpolation:\s*'bilinear'/.test(appSrc));

{
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shadow-worker.js'), 'utf8') +
                  '\nthis.computeShadow = computeShadow;', ctx);
  const computeShadow = ctx.computeShadow;

  // Synthetic terrain on a 768×768 near grid (tile in the middle), 2 m/px.
  const W = 768, MPP = 2;
  const mk = fn => { const g = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) g[y * W + x] = fn(x - 256, y - 256); return g; };
  const run = (near, sun, far = null) => computeShadow({
    near, nearW: W, nearH: W, nearOx: 0, nearOy: 0,
    far, farW: far ? W : 0, farH: far ? W : 0, farOx: 0, farOy: 0, farScale: 16,
    tileOx: 256, tileOy: 256, mpp: MPP, ...sun });
  const alphaAt = (rgba, x, y) => rgba[(y * 256 + x) * 4 + 3];
  const shaded = rgba => { let n = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) n++; return n; };

  ok('Flat ground in sun is unshaded', shaded(run(mk(() => 500), { azimuth: 180, altitude: 20 })) === 0);
  ok('Night shades everything', shaded(run(mk(() => 500), { azimuth: 0, altitude: -3 })) === 65536);

  // 100 m wall along tile row 200 (south side); sun from due south at 10°
  // → shadow reaches 100 / tan(10°) ≈ 567 m ≈ 284 px north of the wall.
  const wall = mk((x, y) => (y >= 200 && y < 204) ? 600 : 500);
  const r = run(wall, { azimuth: 180, altitude: 10 });
  ok('Wall casts shadow just north of it',      alphaAt(r, 128, 190) > 0);
  ok('Ground south of the wall stays lit',      alphaAt(r, 128, 230) === 0);
  // Same wall just south of the tile (row 300): the shadow edge should land
  // ≈ 284 px north of it, i.e. around tile row 16.
  const r2 = run(mk((x, y) => (y >= 300 && y < 304) ? 600 : 500), { azimuth: 180, altitude: 10 });
  ok('Shadow length ≈ h / tan(alt) (567 m at 10°)', alphaAt(r2, 128, 20) > 0 && alphaAt(r2, 128, 12) === 0);
  const rHigh = run(wall, { azimuth: 180, altitude: 60 });
  ok('High sun: short shadow (≈58 m ≈ 29 px)',   alphaAt(rHigh, 128, 185) > 0 && alphaAt(rHigh, 128, 160) === 0);

  // North-facing 35° slope, sun low in the south → self-shaded even with no obstacle
  const tan35 = Math.tan(35 * Math.PI / 180);
  const nSlope = mk((x, y) => 1000 + y * MPP * tan35);   // rises toward the south
  ok('North face self-shades under low southern sun', shaded(run(nSlope, { azimuth: 180, altitude: 15 })) === 65536);
  ok('South face lit under the same sun', shaded(run(mk((x, y) => 1000 - y * MPP * tan35), { azimuth: 180, altitude: 15 })) === 0);

  // Far field: a 600 m ridge ~3 km south, only present in the coarse far grid
  const flatNear = mk(() => 500);
  const far = new Float32Array(W * W).fill(500);
  // far px = 16 near px; tile spans far px 16–32. Ridge at far row 120 (≈ 3.1 km south).
  for (let x = 0; x < W; x++) for (let y = 118; y < 122; y++) far[y * W + x] = 1100;
  ok('Distant ridge (far grid) shades tile at 5° sun', shaded(run(flatNear, { azimuth: 180, altitude: 5 }, far)) === 65536);
  ok('...but not at 25° sun',                       shaded(run(flatNear, { azimuth: 180, altitude: 25 }, far)) === 0);
}

{
  const grab = name => {
    const m = appSrc.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return m && m[0];
  };
  const refrSrc = grab('refraction');
  ok('refraction() declared', !!refrSrc);
  if (refrSrc) {
    const refraction = new Function(refrSrc + '; return refraction;')();
    ok('Refraction ≈ 0.5–0.6° at horizon', refraction(0) > 0.45 && refraction(0) < 0.65);
    ok('Refraction ≈ 0.16° at 5°',        Math.abs(refraction(5) - 0.16) < 0.03);
    ok('Refraction tiny at 60°',          refraction(60) < 0.02);
  }

  const tiffSrc = grab('parseFloatTiff');
  ok('parseFloatTiff() declared', !!tiffSrc);
  if (tiffSrc) {
    const parseFloatTiff = new Function(tiffSrc + '; return parseFloatTiff;')();
    // Build a 4×2 little-endian float32 TIFF, tiled 2×2 blocks, last block sparse.
    const vals = [1, 2, 3, 4, 5, 6, 7, 8];
    const tags = [[256, 3, 4], [257, 3, 2], [258, 3, 32], [259, 3, 1], [277, 3, 1],
                  [322, 3, 2], [323, 3, 2], [339, 3, 3]];
    const n = tags.length + 2, ifd = 8, extra = ifd + 2 + n * 12 + 4;
    const offs = extra, cnts = extra + 8, data = extra + 16;
    const buf = new ArrayBuffer(data + 16), dv = new DataView(buf);
    dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true);
    dv.setUint16(ifd, n, true);
    const all = [...tags.map(([t, ty, v]) => [t, ty, 1, v]), [324, 4, 2, offs], [325, 4, 2, cnts]]
      .sort((a, b) => a[0] - b[0]);
    all.forEach(([t, ty, c, v], i) => { const e = ifd + 2 + i * 12;
      dv.setUint16(e, t, true); dv.setUint16(e + 2, ty, true); dv.setUint32(e + 4, c, true);
      if (ty === 3 && c === 1) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true); });
    dv.setUint32(offs, data, true); dv.setUint32(offs + 4, 0, true);      // block 2 sparse
    dv.setUint32(cnts, 16, true);   dv.setUint32(cnts + 4, 0, true);
    [1, 2, 5, 6].forEach((v, i) => dv.setFloat32(data + i * 4, v, true)); // block 1 = cols 0-1
    const t = parseFloatTiff(buf);
    ok('parseFloatTiff reads tiled float32', t && t.width === 4 && t.height === 2 &&
       t.data[0] === 1 && t.data[1] === 2 && t.data[4] === 5 && t.data[5] === 6);
    ok('parseFloatTiff: sparse block → NaN', t && Number.isNaN(t.data[2]) && Number.isNaN(t.data[7]));
    ok('parseFloatTiff rejects non-TIFF', parseFloatTiff(new ArrayBuffer(16)) === null);
  }
}

/* ─── 9d. NLS grids & datum alignment ─────────────────────────────────── */
console.log('\n── 9d. NLS grids & datum alignment ──');

for (const c of ['slopeLayer', 'heatmapLayer', 'shadowLayer']) {
  ok(`const ${c} declared`, new RegExp(`^const ${c}\\s*=`, 'm').test(appSrc));
}
{
  const grab = name => {
    const m = appSrc.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return m && m[0];
  };
  const parseAsciiGrid = new Function(grab('parseAsciiGrid') + '; return parseAsciiGrid;')();
  const sampleGrid     = new Function(grab('sampleGrid') + '; return sampleGrid;')();

  // NLS with SCALEFACTOR < 1 writes dx/dy (non-square cells), not cellsize
  const g = parseAsciiGrid('ncols 3\nnrows 2\nxllcorner 1000\nyllcorner 5000\ndx 8.008\ndy 8\n' +
                           '1 2 3\n4 5 6\n');
  ok('parseAsciiGrid reads dx/dy', g.cellX === 8.008 && g.cellY === 8);
  ok('parseAsciiGrid reads values row-major', g.grid[0] === 1 && g.grid[5] === 6);
  // Cell centres: col 0 at E = 1004.004, row 0 (top) at N = 5012
  ok('sampleGrid hits cell centre (top-left)',  Math.abs(sampleGrid(g, 1004.004, 5012) - 1) < 1e-6);
  ok('sampleGrid hits cell centre (bottom-right)', Math.abs(sampleGrid(g, 1000 + 8.008 * 2.5, 5004) - 6) < 1e-6);
  ok('sampleGrid interpolates between centres',  Math.abs(sampleGrid(g, 1000 + 8.008 * 1.5, 5008) - 3.5) < 1e-6);
  ok('sampleGrid: NaN well outside the grid (no edge streaks)', Number.isNaN(sampleGrid(g, 1100, 5004)));
  ok('sampleGrid: nearest edge value just outside', sampleGrid(g, 999, 5004) === 4);

  const datumOffset = new Function(grab('_datumOffset') + '; return _datumOffset;')();
  const hi = new Float32Array(65536).map((_, i) => 200 + (i % 7));
  const tr = hi.map(v => v + 24);
  for (let i = 0; i < 2000; i++) tr[i] = NaN;
  ok('_datumOffset finds a constant −24 m datum shift', Math.abs(datumOffset(hi, tr) + 24) < 1e-4);
  ok('_datumOffset null without overlap', datumOffset(hi, new Float32Array(65536).fill(NaN)) === null);
}
{
  const vm = require('vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shadow-worker.js'), 'utf8') + '\nthis.computeShadow = computeShadow;', ctx);
  const flat = new Float32Array(768 * 768).fill(300);
  const r = ctx.computeShadow({ near: flat, nearW: 768, nearH: 768, nearOx: 0, nearOy: 0, far: null,
    tileOx: 256, tileOy: 256, mpp: 4, azimuth: 200, altitude: 5 });
  let n = 0; for (let i = 3; i < r.length; i += 4) if (r[i]) n++;
  ok('Flat ground under a 5° sun is not tinted', n === 0);
}

/* ─── 10. CSS custom properties ──────────────────────────────────────── */
console.log('\n── 10. CSS ──');

const cssVars = ['--accent', '--slope-a', '--slope-b', '--slope-c', '--slope-d'];
for (const v of cssVars) {
  ok(`CSS variable ${v} defined`, stylesSrc.includes(v));
}

/* ─── Summary ─────────────────────────────────────────────────────────── */
console.log(`\n${'─'.repeat(44)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(44));

if (failed > 0) process.exit(1);
