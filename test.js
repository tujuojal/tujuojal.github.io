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

/* ─── 7. 3D/2D transition cleanup ─────────────────────────────────────── */
console.log('\n── 7. 3D transition layer cleanup ──');

ok('Norway avalanche layer removed on 2D→3D',
   appSrc.includes('map.removeLayer(avalancheLayer)'));
ok('Japan slope layer removed on 2D→3D',
   appSrc.includes('map.removeLayer(jpSlopeLayer)'));
ok('Japan hazard layer removed on 2D→3D',
   appSrc.includes('map.removeLayer(jpHazardLayer)'));
ok('Norway avalanche layer restored on 3D→2D',
   appSrc.includes('_applyAvalancheLayers()'));

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
