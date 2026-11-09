/**
 * PowSurf terrain shadow engine.
 *
 * Runs as a Web Worker (spawned by app.js) and is also loaded as a plain
 * <script> so the main thread can fall back to it when workers are
 * unavailable. Pure computation — no DOM, no network.
 *
 * For every pixel of one 256×256 map tile it decides whether the sun can be
 * seen from there:
 *   1. Self-shade  — the ground tilts away from the sun (normal · sun ≤ 0).
 *   2. Cast shadow — a ray marched toward the sun hits higher terrain
 *                    (ridges, peaks, gully walls), including ones far
 *                    outside the tile.
 *
 * Elevation comes in two grids, both in global Web-Mercator pixel space:
 *   near — the tile's own zoom, typically the tile plus its sun-side
 *          neighbours, from the best available DEM (Kartverket 1 m,
 *          NLS 2 m or Terrarium). NaN where unknown.
 *   far  — Terrarium at a coarser zoom covering ~±30 tiles, used once a ray
 *          leaves the near grid, so long low-sun shadows are still caught.
 */

'use strict';

const SHADE_RGB     = [10, 15, 35];
const SHADE_ALPHA   = 150;   // terrain shadow
const NIGHT_ALPHA   = 175;   // sun below the horizon
const TERMINATOR    = 0.12;  // lit slopes with normal·sun below this fade toward shade
const EARTH_R       = 6371000;
const REFRACTION_K  = 0.13;  // standard terrestrial refraction coefficient
const SHADOW_BIAS_M = 0.3;   // tolerance for DEM noise / interpolation

/**
 * @param {object} p
 * @param {Float32Array} p.near   nearW × nearH elevations (m), NaN = no data
 * @param {number} p.nearW, p.nearH
 * @param {number} p.nearOx, p.nearOy  global pixel coords (tile zoom) of near[0]
 * @param {Float32Array|null} p.far    farW × farH elevations at a coarser zoom
 * @param {number} p.farW, p.farH
 * @param {number} p.farOx, p.farOy    global pixel coords (far zoom) of far[0]
 * @param {number} p.farScale          tile-zoom pixels per far pixel (power of 2)
 * @param {number} p.tileOx, p.tileOy  global pixel coords of the tile's corner
 * @param {number} p.mpp               metres per pixel at the tile
 * @param {number} p.azimuth           sun azimuth, degrees CW from north
 * @param {number} p.altitude          apparent sun altitude, degrees
 * @returns {Uint8ClampedArray} 256×256 RGBA
 */
function computeShadow(p) {
  const out = new Uint8ClampedArray(256 * 256 * 4);
  const [R, G, B] = SHADE_RGB;

  if (p.altitude <= 0) {
    for (let i = 0; i < out.length; i += 4) {
      out[i] = R; out[i + 1] = G; out[i + 2] = B; out[i + 3] = NIGHT_ALPHA;
    }
    return out;
  }

  const { near, nearW, nearH, nearOx, nearOy, far, farW, farH, farOx, farOy,
          tileOx, tileOy, mpp } = p;
  const farScale = p.farScale || 1;
  const D2R = Math.PI / 180;
  const az  = p.azimuth * D2R;
  const alt = p.altitude * D2R;
  const sx = Math.sin(az) * Math.cos(alt);   // sun vector: east
  const sy = Math.cos(az) * Math.cos(alt);   //             north
  const sz = Math.sin(alt);                  //             up
  const tanAlt = Math.tan(alt);
  // Ray direction in pixel space (pixel y grows southward)
  const dx = Math.sin(az);
  const dy = -Math.cos(az);
  const curv = (1 - REFRACTION_K) / (2 * EARTH_R);

  const nearPyr  = buildMaxPyramid(near, nearW, nearH);
  const farPyr   = far ? buildMaxPyramid(far, farW, farH) : null;
  const farShift = Math.round(Math.log2(farScale));
  let maxElev = -Infinity;
  for (const pyr of [nearPyr, farPyr]) {
    if (!pyr) continue;
    const top = pyr[pyr.length - 1].data;
    for (let i = 0; i < top.length; i++) if (top[i] > maxElev) maxElev = top[i];
  }

  const nearAt = (x, y) => near[y * nearW + x];

  /** Bilinear sample of the near grid at global pixel coords; NaN if outside / no data. */
  function sampleNear(gx, gy) {
    const u = gx - nearOx - 0.5, v = gy - nearOy - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= nearW || y0 + 1 >= nearH) return NaN;
    const fx = u - x0, fy = v - y0;
    const i = y0 * nearW + x0;
    return near[i]         * (1 - fx) * (1 - fy) + near[i + 1]         * fx * (1 - fy) +
           near[i + nearW] * (1 - fx) * fy       + near[i + nearW + 1] * fx * fy;
  }

  // Pyramid levels as flat lists for the hot loop
  const nLv = nearPyr.map(l => l.data), nLw = nearPyr.map(l => l.w), nLh = nearPyr.map(l => l.h);
  const nTop = nearPyr.length - 1;
  const fLv = farPyr ? farPyr.map(l => l.data) : [], fLw = farPyr ? farPyr.map(l => l.w) : [];
  const fLh = farPyr ? farPyr.map(l => l.h) : [];
  const fTop = fLv.length - 1;
  const invFar = 1 / farScale;

  /**
   * Terrain height to test against the ray at block level `lvl` (blocks of
   * 2^lvl near px). Level 0 is an exact bilinear sample; coarser levels give
   * the block maximum, so stepping a block at a time can never skip a ridge.
   */
  function terrainAt(gx, gy, lvl) {
    let h = NaN;
    if (lvl === 0) {
      h = sampleNear(gx, gy);
    } else {
      const u = gx - nearOx, v = gy - nearOy;
      if (u >= 0 && v >= 0) {
        const l = lvl < nTop ? lvl : nTop;
        const bx = (u | 0) >> l, by = (v | 0) >> l;
        if (bx < nLw[l] && by < nLh[l]) h = nLv[l][by * nLw[l] + bx];
      }
    }
    if (h === h || fTop < 0) return h;
    const u = gx * invFar - farOx, v = gy * invFar - farOy;
    if (u < 0 || v < 0) return NaN;
    let l = lvl - farShift;
    if (l <= 0) {
      // Finer than a far pixel: interpolate so distant shadows don't stair-step
      const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < farW && y0 + 1 < farH) {
        const fx = u - 0.5 - x0, fy = v - 0.5 - y0, i = y0 * farW + x0;
        const b = far[i]        * (1 - fx) * (1 - fy) + far[i + 1]        * fx * (1 - fy) +
                  far[i + farW] * (1 - fx) * fy       + far[i + farW + 1] * fx * fy;
        if (b === b) return b;
      }
      l = 0;
    }
    if (l > fTop) l = fTop;
    const bx = (u | 0) >> l, by = (v | 0) >> l;
    if (bx >= fLw[l] || by >= fLh[l]) return NaN;
    return fLv[l][by * fLw[l] + bx];
  }

  /** Height of the sun ray d px from a point at z0, after earth curvature. */
  function rayHeight(z0, d) {
    const dist = d * mpp;
    return z0 + dist * tanAlt - dist * dist * curv;
  }

  /**
   * A block maximum at level `lvl` rose above the ray. Re-check the stretch
   * of ray that block can span using blocks 8× smaller, recursing on any
   * hit until exact samples confirm it — otherwise shadow edges from distant
   * ridges come out as block-sized stair steps.
   */
  function refineHit(gx, gy, z0, d, lvl) {
    const span = 1.5 * 2 ** lvl;
    const fl   = Math.max(0, lvl - 3);
    const step = fl === 0 ? 1 : 2 ** (fl - 1);
    for (let t = Math.max(1, d - span); t <= d + span; t += step) {
      const h = terrainAt(gx + dx * t, gy + dy * t, fl);
      if (h > rayHeight(z0, t) + SHADOW_BIAS_M &&
          (fl === 0 || refineHit(gx, gy, z0, t, fl))) return true;
    }
    return false;
  }

  const bx = tileOx - nearOx;   // tile corner inside the near grid
  const by = tileOy - nearOy;

  /** Ray-march from tile pixel (px, py) toward the sun; true if terrain blocks it. */
  function castShadow(px, py, z0) {
    // 1 px steps for the first 32 px, then each distance octave
    // [16·2^l, 32·2^l) in 32 steps against block maxima of 2^l px.
    // Stop once the ray clears all known terrain.
    const gx = tileOx + px + 0.5, gy = tileOy + py + 0.5;
    let d = 1, lvl = 0, step = 1, nextLvlAt = 32;
    for (;;) {
      if (d >= nextLvlAt) {            // next distance octave: coarser blocks, longer steps
        lvl = lvl === 0 ? 1 : lvl + 1;
        step = 2 ** (lvl - 1);
        nextLvlAt = 32 * 2 ** lvl;
      }
      const h = terrainAt(gx + dx * d, gy + dy * d, lvl);
      if (h !== h) return false;          // left all known terrain
      const dist = d * mpp;
      const rayZ = z0 + dist * tanAlt - dist * dist * curv;
      if (h > rayZ + SHADOW_BIAS_M &&
          (lvl === 0 || refineHit(gx, gy, z0, d, lvl))) return true;
      if (rayZ > maxElev) return false;
      d += step;
    }
  }

  // Pass 1: elevation and illumination (normal · sun) for every pixel.
  const elev = new Float32Array(65536);
  const cosI = new Float32Array(65536);
  for (let py = 0; py < 256; py++) {
    const ny = by + py;
    for (let px = 0; px < 256; px++) {
      const nx = bx + px;
      const i  = py * 256 + px;
      const z0 = nearAt(nx, ny);
      elev[i] = z0;
      if (z0 !== z0) { cosI[i] = NaN; continue; }   // no data → transparent

      // Surface gradient; central differences, one-sided where a neighbour
      // is missing (outside the grid or NaN) so tile edges don't seam.
      const zw = nx > 0         ? nearAt(nx - 1, ny) : NaN;
      const ze = nx < nearW - 1 ? nearAt(nx + 1, ny) : NaN;
      const zn = ny > 0         ? nearAt(nx, ny - 1) : NaN;
      const zs = ny < nearH - 1 ? nearAt(nx, ny + 1) : NaN;
      const dzE = (ze === ze && zw === zw) ? (ze - zw) / (2 * mpp)
                : ze === ze ? (ze - z0) / mpp : zw === zw ? (z0 - zw) / mpp : 0;
      const dzN = (zn === zn && zs === zs) ? (zn - zs) / (2 * mpp)
                : zn === zn ? (zn - z0) / mpp : zs === zs ? (z0 - zs) / mpp : 0;
      cosI[i] = (-dzE * sx - dzN * sy + sz) / Math.sqrt(dzE * dzE + dzN * dzN + 1);
    }
  }

  // Pass 2: cast shadows. Rays are traced on every other pixel (plus the
  // last row/column); in-between pixels copy their traced neighbours when
  // those all agree and are traced themselves only along shadow edges.
  const UNKNOWN = 2;
  const cast = new Uint8Array(65536).fill(UNKNOWN);
  const coarse = v => (v & 1) === 0 || v === 255;
  for (let py = 0; py < 256; py++) {
    if (!coarse(py)) continue;
    for (let px = 0; px < 256; px++) {
      const i = py * 256 + px;
      if (coarse(px) && elev[i] === elev[i]) cast[i] = castShadow(px, py, elev[i]) ? 1 : 0;
    }
  }
  for (let py = 0; py < 256; py++) {
    const ys = coarse(py) ? [py] : [py - 1, py + 1];
    for (let px = 0; px < 256; px++) {
      const i = py * 256 + px;
      if (cast[i] !== UNKNOWN || !(cosI[i] > 0)) continue;
      const xs = coarse(px) ? [px] : [px - 1, px + 1];
      let v = -1;
      for (const yy of ys) for (const xx of xs) {
        const c = cast[yy * 256 + xx];
        v = v === -1 || v === c ? c : UNKNOWN;
      }
      cast[i] = v === 0 || v === 1 ? v : (castShadow(px, py, elev[i]) ? 1 : 0);
    }
  }

  // Pass 3: colour. Shade = self-shaded or cast shadow; lit slopes nearly
  // edge-on to the sun fade toward shade so the terminator isn't a hard line.
  for (let i = 0; i < 65536; i++) {
    const c = cosI[i];
    if (c !== c) continue;
    let alpha = 0;
    if (c <= 0 || cast[i] === 1) alpha = SHADE_ALPHA;
    else if (c < TERMINATOR) alpha = Math.round(SHADE_ALPHA * (1 - c / TERMINATOR));
    if (alpha) {
      const o = i << 2;
      out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = alpha;
    }
  }
  return out;
}

/**
 * Max-pyramid of an elevation grid: level l holds the highest value in each
 * 2^l × 2^l block (NaN ignored; NaN only if the whole block is), down to a
 * few cells across.
 */
function buildMaxPyramid(grid, w, h) {
  const levels = [{ data: grid, w, h }];
  while (w > 4 && h > 4) {
    const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
    const src = levels[levels.length - 1].data;
    const dst = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let m = NaN;
        for (let k = 0; k < 4; k++) {
          const sx = 2 * x + (k & 1), sy = 2 * y + (k >> 1);
          if (sx >= w || sy >= h) continue;
          const v = src[sy * w + sx];
          if (v === v && !(v <= m)) m = v;
        }
        dst[y * nw + x] = m;
      }
    }
    levels.push({ data: dst, w: nw, h: nh });
    w = nw; h = nh;
  }
  return levels;
}

// Worker entry point (no-op when loaded as a page script)
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { id, params } = e.data;
    const rgba = computeShadow(params);
    self.postMessage({ id, rgba }, [rgba.buffer]);
  };
}
