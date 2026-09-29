/**
 * Builds the spray intro's data from the centerlines and the logo outline.
 *   src/lib/spray/strokes.svg  -> src/lib/spray/paths.json  (arc-length samples)
 *   src/data/logo.ts           -> src/lib/spray/logo-mask.png (soft outline, MASK_RECT; the stroke masks are cut by it)
 *   src/lib/spray/reference/strokes.json -> drips + full stop (and a check that
 *                              strokes.svg's centerlines still match it)
 *   (generated)                -> src/lib/spray/blue-noise.png (grain tile, void-and-cluster)
 *   centerlines + mask         -> src/lib/spray/stroke-masks.png (each stroke's own core clip, RGB) and
 *                                 stroke-masks-odd.png (the parts split at turns, gray). No alpha: WebKit
 *                                 premultiplies PNGs on decode, which zeroes RGB wherever A is 0
 *
 * Run: npm run spray:paths. Node >= 23.6 strips the .ts imports natively.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { svgPathProperties } from 'svg-path-properties';
import { Resvg } from '@resvg/resvg-js';
import { LETTERS_D, STOP_D } from '../src/data/logo.ts';
import { dripDuration, look, MASK_RECT, schedule, strokeDuration } from '../src/lib/spray/look.ts';
import { strokeEase } from '../src/lib/spray/ease.ts';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const r3 = (n) => Math.round(n * 1000) / 1000;


// 1. Strokes: arc-length samples, plus the sharp turns the hand eases into
const strokesSvg = readFileSync(root('src/lib/spray/strokes.svg'), 'utf8');
const source = [...strokesSvg.matchAll(/<path\s+([^>]*?)\/>/g)].map(([, attrs]) => {
  const attr = (name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  return { id: attr('id'), letter: attr('data-letter'), name: attr('data-name').replace('&amp;', '&'), d: attr('d') };
});
const strokes = source.map(({ id, letter, name, d }) => {
  const props = new svgPathProperties(d);
  const length = props.getTotalLength();
  const points = [];
  const n = Math.max(1, Math.ceil(length / look.sampleStep));
  for (let i = 0; i <= n; i++) {
    const p = props.getPointAtLength(Math.min(i * look.sampleStep, length));
    points.push(r3(p.x), r3(p.y));
  }
  const turns = letter === '.' ? [] : findTurns(props, length);
  return { id, letter, name, length: r3(length), points, ...(turns.length ? { turns } : {}) };
});

/**
 * Sharp turns along a centerline (look.ts schedule.turns): where the direction
 * over the last `window` units and the next `window` units differs by more than
 * minAngle. One turn per run of such samples, at its sharpest point.
 */
function findTurns(props, length) {
  const T = schedule.turns;
  const dirAt = (a, b) => {
    const p = props.getPointAtLength(Math.max(0, a));
    const q = props.getPointAtLength(Math.min(length, b));
    return Math.atan2(q.y - p.y, q.x - p.x);
  };
  const turns = [];
  let run = null;
  for (let s = T.endMargin; s <= length - T.endMargin; s += look.sampleStep) {
    let angle = Math.abs(dirAt(s, s + T.window) - dirAt(s - T.window, s)) * (180 / Math.PI);
    if (angle > 180) angle = 360 - angle;
    if (angle >= T.minAngle) {
      if (!run || angle > run.angle) run = { ...(run ?? {}), s, angle };
    } else if (run) {
      turns.push(run);
      run = null;
    }
  }
  if (run) turns.push(run);
  return turns.map(({ s, angle }) => {
    const f = Math.min(1, Math.max(0, (angle - T.minAngle) / (T.maxAngle - T.minAngle)));
    return { s: r3(s), angle: Math.round(angle), speed: r3(T.speed[0] + (T.speed[1] - T.speed[0]) * f) };
  });
}

// 2. Reference: centerlines must match strokes.json; drips + full stop come from it
const ref = JSON.parse(readFileSync(root('src/lib/spray/reference/strokes.json'), 'utf8'));
const svgD = Object.fromEntries(source.map((x) => [x.id, x.d]));
for (const r of ref.strokes) {
  if (svgD[r.id] !== r.d) throw new Error(`strokes.svg #${r.id} differs from reference/strokes.json`);
}
const drips = ref.drips.map((d) => {
  const timing = schedule.drips[d.id];
  if (timing === undefined) throw new Error(`no timing for ${d.id} in look.ts schedule.drips`);
  const landed = paintLands(d, timing.stroke);
  const start = r3(landed + timing.after);
  const end = start + dripDuration(d.beadY - d.top);
  if (end > schedule.end + 1e-6) throw new Error(`${d.id} runs to ${end.toFixed(2)}s, past schedule.end ${schedule.end}s`);
  return { ...d, landed: r3(landed), start };
});

/**
 * When paint lands on a drip (s): the last moment the nozzle of stroke `id` is
 * at its closest to the drip's top. The tap stays put, so its paint keeps
 * pooling until it ends.
 */
function paintLands(drip, id) {
  const stroke = strokes.find((s) => s.id === id);
  const slot = schedule.strokes.find((s) => s.id === id);
  if (!stroke || !slot) throw new Error(`${drip.id}: no stroke ${id}`);
  const duration = slot.duration ?? strokeDuration(stroke.length);
  if (stroke.letter === '.') return slot.at + duration;
  let best = Infinity;
  let arc = 0;
  for (let i = 0; i < stroke.points.length / 2; i++) {
    const dist = Math.hypot(stroke.points[2 * i] - drip.x, stroke.points[2 * i + 1] - drip.top);
    if (dist <= best) {
      best = dist;
      arc = Math.min(i * look.sampleStep, stroke.length);
    }
  }
  // The ease is monotonic: bisect for the progress where the nozzle reaches arc
  const ease = strokeEase(stroke, slot.ease, schedule.ease);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) * stroke.length < arc) lo = mid;
    else hi = mid;
  }
  return slot.at + hi * duration;
}

const data = {
  weight: ref.strokeWeight,
  stop: ref.fullStop,
  drips,
  strokes,
};
// paths.json is written in 3b, once each stroke has its mask channel

// 3. Masks over MASK_RECT (2048 x 739 over 244 x 88). Soft edges come from
// the signed distance to the shape's edge, d (units, + inside): alpha = Phi(d / edge),
// the profile a Gaussian blur gives a straight edge. Unlike a blur, a thin gap
// (a counter's sharp tip) stays open: both its sides don't add up into it.
// Distances are measured to the geometry itself (the outline's path, the
// centerlines' segments), not to a pixel grid, so edges don't step.
const { width: W, height: H, edge } = look.mask;
const R = MASK_RECT;
const px = W / R.w; // mask pixels per unit
const toX = (i) => R.x + (i + 0.5) / px;
const toY = (j) => R.y + (j + 0.5) / px;
/** Beyond this |d| (units) Phi is 0 or 1 to 8 bits: distances are clamped to it */
const REACH = edge * 3.2;
const soft = (sd) => Float32Array.from(sd, (d) => phi(d / edge));

// Hard raster: inside / outside at each pixel centre (the sign of d)
const outlineIn = (() => {
  const rgba = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${R.x} ${R.y} ${R.w} ${(R.w * H) / W}"><rect x="${R.x}" y="${R.y}" width="100%" height="100%" fill="#000"/><path fill="#fff" fill-rule="evenodd" d="${LETTERS_D}"/><path fill="#fff" d="${STOP_D}"/></svg>`,
    { fitTo: { mode: 'original' } },
  ).render().pixels; // a getter that copies: read it once
  return Uint8Array.from({ length: W * H }, (_, i) => (rgba[i * 4] >= 128 ? 1 : 0));
})();

// Each drip's letter edge: the reference drips start inside the paint; the
// drip shows from where the outline ends below its top (swell, neck, taper start there)
for (const d of data.drips) {
  const i = Math.round((d.x - R.x) * px - 0.5);
  let j = Math.round((d.top - R.y) * px - 0.5);
  while (j < H - 1 && outlineIn[j * W + i]) j++;
  d.edge = r3(toY(j) - 0.5 / px);
  if (d.edge < d.top || d.edge > d.beadY - d.bead) throw new Error(`${d.id}: letter edge ${d.edge} outside ${d.top}..${d.beadY}`);
}

// The outline's edge: its path sampled every 0.02 units, bucketed by 1-unit cell
const outlineSd = (() => {
  const cell = 1;
  const cols = Math.ceil(R.w / cell);
  const buckets = new Map();
  for (const d of [LETTERS_D, STOP_D]) {
    // One subpath at a time: a path's length jumps over its moveTos
    for (const sub of d.match(/[Mm][^Mm]*/g)) {
      const props = new svgPathProperties(sub);
      const L = props.getTotalLength();
      for (let t = 0; t <= L; t += 0.02) {
        const p = props.getPointAtLength(t);
        const key = Math.floor((p.y - R.y) / cell) * cols + Math.floor((p.x - R.x) / cell);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p.x, p.y);
      }
    }
  }
  const out = new Float32Array(W * H);
  const reachCells = Math.ceil(REACH / cell);
  for (let j = 0; j < H; j++) {
    const y = toY(j);
    const cy = Math.floor((y - R.y) / cell);
    for (let i = 0; i < W; i++) {
      const x = toX(i);
      const cx = Math.floor((x - R.x) / cell);
      let best = REACH * REACH;
      for (let v = cy - reachCells; v <= cy + reachCells; v++) {
        for (let u = cx - reachCells; u <= cx + reachCells; u++) {
          const b = buckets.get(v * cols + u);
          if (!b) continue;
          for (let n = 0; n < b.length; n += 2) {
            const q = (b[n] - x) ** 2 + (b[n + 1] - y) ** 2;
            if (q < best) best = q;
          }
        }
      }
      const o = j * W + i;
      out[o] = (outlineIn[o] ? 1 : -1) * Math.sqrt(best);
    }
  }
  return out;
})();
const outlineSoft = soft(outlineSd);
writeFileSync(root('src/lib/spray/logo-mask.png'), encodePng(Uint8Array.from(outlineSoft, (v) => Math.round(v * 255)), W, H, 1));

// 3b. Per-stroke core masks, same grid. Each stroke's core paints only inside
// its own shape: its centerline stroked at its weight (round caps, as in
// Figma), with the same soft edge, cut by the logo mask so the outer edge
// stays the outline's. A stroke with sharp turns is masked in parts, split at
// its turns: paint laid before a turn stays in the part before it, so a stroke
// that comes back past itself (the R's bowl and leg) shows no piece of its
// later part early. Parts overlap at their turn, so they alternate between the
// stroke's channel (even parts) and A (odd parts, far apart from each other). Outline slivers no stroke covers (< 0.5 u, along the
// edges; the fillets at joins) go to the last stroke that reaches them, grown
// by look.strokeMask.seam so the soft edges overlap at every join. Strokes are
// coloured so that strokes sharing a channel are never within
// look.strokeMask.gap of each other: channel c of stroke-masks.png (RGB) is
// the union of its strokes' masks, and the core and fog buffers keep one
// density per channel (paint.ts), combined only in the composite.
{
  const SM = look.strokeMask;
  const pts = strokes.map((st) => Float64Array.from(st.points));
  const half = strokes.map((st) => (st.letter === '.' ? ref.fullStop.strokeWeight : ref.strokeWeight) / 2);
  // Parts: [stroke, first sample, last sample], split at the turns
  const parts = [];
  strokes.forEach((st, k) => {
    const cuts = [0, ...(st.turns ?? []).map((t) => Math.round(t.s / look.sampleStep)), pts[k].length / 2 - 1];
    for (let n = 0; n + 1 < cuts.length; n++) parts.push({ k, odd: n % 2 === 1, from: cuts[n], to: cuts[n + 1] });
  });
  /** Distance to a centerline; `at` = arc length of its nearest sample */
  const nearestOn = (k, x, y) => {
    const p = pts[k];
    let best = Infinity, at = 0;
    for (let n = 0; n < p.length; n += 2) {
      const ex = p[n] - x, ey = p[n + 1] - y;
      const q = ex * ex + ey * ey;
      if (q < best) { best = q; at = (n / 2) * look.sampleStep; }
    }
    return { d: Math.sqrt(best), at };
  };
  const distTo = (k, x, y) => nearestOn(k, x, y).d;
  // A flying start lays (almost) no paint over its ramp: it can't be the one to fill a join there
  const rampOf = strokes.map((st) => look.flyingStarts.find((f) => f.stroke === st.id)?.length ?? 0);
  /** Exact distance to a part of a centerline (samples every look.sampleStep, from..to) */
  const segDist = (k, x, y, from, to) => {
    const p = pts[k];
    let best = Infinity;
    if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y);
    for (let n = from * 2; n + 3 <= to * 2 + 1; n += 2) {
      const ax = p[n], ay = p[n + 1], bx = p[n + 2] - ax, by = p[n + 3] - ay;
      const l2 = bx * bx + by * by;
      const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * bx + (y - ay) * by) / l2)) : 0;
      const q = (ax + t * bx - x) ** 2 + (ay + t * by - y) ** 2;
      if (q < best) best = q;
    }
    return Math.sqrt(best);
  };
  // Each part's signed distance (half - distance to its centerline), clamped; only near the part
  const partSd = parts.map(({ k, from, to }) => {
    const sd = new Float32Array(W * H).fill(-REACH);
    const p = pts[k];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let n = from * 2; n <= to * 2; n += 2) {
      x0 = Math.min(x0, p[n]); x1 = Math.max(x1, p[n]);
      y0 = Math.min(y0, p[n + 1]); y1 = Math.max(y1, p[n + 1]);
    }
    const m = half[k] + REACH + SM.seam;
    const i0 = Math.max(0, Math.floor((x0 - m - R.x) * px)), i1 = Math.min(W - 1, Math.ceil((x1 + m - R.x) * px));
    const j0 = Math.max(0, Math.floor((y0 - m - R.y) * px)), j1 = Math.min(H - 1, Math.ceil((y1 + m - R.y) * px));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        sd[j * W + i] = Math.max(-REACH, Math.min(REACH, half[k] - segDist(k, toX(i), toY(j), from, to)));
      }
    }
    return sd;
  });

  // Slivers: inside the outline, outside every stroke shape
  const sliver = parts.map(() => new Uint8Array(W * H));
  let sliverCount = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = j * W + i;
      if (!outlineIn[o] || partSd.some((s) => s[o] > 0)) continue;
      sliverCount++;
      // A fillet where strokes meet only exists once they're all down: it goes
      // to the last of them (drawing order) that paints there, not one still
      // ramping in (the crossbar's flying start over the P's top bar). Edge
      // slivers have one stroke near.
      const x = toX(i), y = toY(j);
      let id = -1, nd = Infinity, nearest = 0;
      for (let k = 0; k < pts.length; k++) {
        const { d, at } = nearestOn(k, x, y);
        if (d <= half[k] + SM.fillet && at >= rampOf[k]) id = k;
        if (d < nd) { nd = d; nearest = k; }
      }
      // ... and within that stroke, to its nearest part
      const k = id < 0 ? nearest : id;
      let part = -1, pd = Infinity;
      parts.forEach((pt, n) => {
        if (pt.k !== k) return;
        const d = segDist(k, x, y, pt.from, pt.to);
        if (d < pd) { pd = d; part = n; }
      });
      sliver[part][o] = 1;
    }
  }

  // Part shape grown by its slivers (+ seam), soft, cut by the logo mask (outer edge = the outline's)
  const masks = parts.map((_, n) => {
    const toSliver = edt(sliver[n], W, H, 1);
    const sd = partSd[n];
    const m = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const grown = SM.seam - Math.sqrt(toSliver[i]) / px;
      m[i] = Math.min(phi(Math.max(sd[i], Math.min(grown, REACH)) / edge), outlineSoft[i]);
    }
    return m;
  });

  // Channels: greedy colouring in drawing order; strokes closer than gap never share one
  const gapOf = (a, b) => {
    let best = Infinity;
    for (let n = 0; n < pts[a].length; n += 2) best = Math.min(best, distTo(b, pts[a][n], pts[a][n + 1]));
    return best - half[a] - half[b];
  };
  const channel = [];
  for (let k = 0; k < strokes.length; k++) {
    const taken = new Set(channel.filter((_, m) => gapOf(k, m) < SM.gap));
    const c = [0, 1, 2].find((c) => !taken.has(c));
    if (c === undefined) throw new Error(`stroke ${strokes[k].id} needs a 4th mask channel`);
    channel.push(c);
    strokes[k].channel = c;
  }
  // Odd parts share one mask (stroke-masks-odd.png): no two may come within gap of each other
  const odd = parts.filter((pt) => pt.odd);
  for (let a = 0; a < odd.length; a++) {
    for (let b = a + 1; b < odd.length; b++) {
      let best = Infinity;
      const pa = pts[odd[a].k];
      for (let n = odd[a].from; n <= odd[a].to; n++) best = Math.min(best, segDist(odd[b].k, pa[n * 2], pa[n * 2 + 1], odd[b].from, odd[b].to));
      if (best - half[odd[a].k] - half[odd[b].k] < SM.gap) throw new Error(`odd parts of ${strokes[odd[a].k].id} and ${strokes[odd[b].k].id} too close for one mask channel`);
    }
  }
  const out = new Uint8Array(W * H * 3);
  const outOdd = new Uint8Array(W * H);
  masks.forEach((m, n) => {
    const odd = parts[n].odd;
    const c = channel[parts[n].k];
    for (let i = 0; i < W * H; i++) {
      const v = Math.round(m[i] * 255);
      if (odd) outOdd[i] = Math.max(outOdd[i], v);
      else out[i * 3 + c] = Math.max(out[i * 3 + c], v);
    }
  });
  writeFileSync(root('src/lib/spray/stroke-masks.png'), encodePng(out, W, H, 3));
  writeFileSync(root('src/lib/spray/stroke-masks-odd.png'), encodePng(outOdd, W, H, 1));
  writeFileSync(root('src/lib/spray/paths.json'), JSON.stringify(data));
  const rgb = 'RGB';
  console.log(`stroke masks ${W}x${H}, ${(sliverCount / px / px).toFixed(1)} sq units of outline slivers; channels ${strokes.map((s, k) => `${s.id}:${rgb[channel[k]]}`).join(' ')}; ${odd.length} odd parts (${odd.map((pt) => strokes[pt.k].id).join(', ')})`);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7) */
function phi(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Squared distance (pixels) to the nearest pixel whose value is `target` (Felzenszwalb-Huttenlocher) */
function edt(bin, w, h, target) {
  const INF = 1e20;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = bin[i] === target ? 0 : INF;
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s;
      do {
        const r = v[k];
        s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => grid[y * w + x], (y, val) => (grid[y * w + x] = val));
  for (let y = 0; y < h; y++) pass(w, (x) => grid[y * w + x], (x, val) => (grid[y * w + x] = val));
  return grid;
}

/** resvg only writes RGBA; the mask needs one channel. */
function grayPng(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = rgba[i * 4];
  return encodePng(gray, w, h, 1);
}

/** Minimal 8-bit PNG, grayscale (1 channel), RGB (3) or RGBA (4), "Up" filter per row */
function encodePng(data, w, h, channels) {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  // Row deltas: soft edges and flat regions compress far better
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x];
      const above = y ? data[(y - 1) * stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (v - above) & 0xff;
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, { 1: 0, 3: 2, 4: 6 }[channels], 0, 0, 0], 8); // 8-bit, grayscale, RGB or RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 4. Blue-noise grain tile: void-and-cluster (Ulichney 1993), seeded, toroidal
writeFileSync(root('src/lib/spray/blue-noise.png'), grayPng(blueNoise(look.grain.tile), look.grain.tile, look.grain.tile));

function blueNoise(n, sigma = 1.5) {
  const N = n * n;
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  // Toroidal gaussian kernel
  const r = Math.ceil(sigma * 4);
  const kernel = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))]);
  const energy = new Float64Array(N);
  const splat = (i, sign) => {
    const x = i % n, y = (i / n) | 0;
    for (const [dx, dy, w] of kernel) energy[((y + dy + n) % n) * n + ((x + dx + n) % n)] += sign * w;
  };
  const extreme = (bits, want, max) => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) if (bits[i] === want && (max ? energy[i] > bv : energy[i] < bv)) { bv = energy[i]; best = i; }
    return best;
  };
  // Initial pattern: ~10 % ones, relaxed until the tightest cluster is the largest void
  const bits = new Uint8Array(N);
  const ones = Math.floor(N * 0.1);
  for (let c = 0; c < ones; ) {
    const i = Math.floor(rand() * N);
    if (!bits[i]) { bits[i] = 1; splat(i, 1); c++; }
  }
  for (;;) {
    const cluster = extreme(bits, 1, true);
    bits[cluster] = 0; splat(cluster, -1);
    const voidI = extreme(bits, 0, false);
    if (voidI === cluster) { bits[cluster] = 1; splat(cluster, 1); break; }
    bits[voidI] = 1; splat(voidI, 1);
  }
  const rank = new Int32Array(N);
  const initial = bits.slice();
  const initialEnergy = energy.slice();
  // Phase 1: remove tightest clusters, ranks ones-1 .. 0
  for (let rk = ones - 1; rk >= 0; rk--) {
    const i = extreme(bits, 1, true);
    bits[i] = 0; splat(i, -1); rank[i] = rk;
  }
  // Phases 2 + 3: from the initial pattern, fill largest voids, ranks ones .. N-1
  bits.set(initial);
  energy.set(initialEnergy);
  for (let rk = ones; rk < N; rk++) {
    const i = extreme(bits, 0, false);
    bits[i] = 1; splat(i, 1); rank[i] = rk;
  }
  // Ranks -> 0..255, laid out as RGBA-like stride 4 for grayPng
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) out[i * 4] = Math.floor((rank[i] * 256) / N);
  return out;
}

// 5. Report
console.log('id  letter  name            length   at     dur    units/s');
for (const s of strokes) {
  const slot = schedule.strokes.find((x) => x.id === s.id);
  const dur = slot.duration ?? strokeDuration(s.length);
  const speed = s.letter === '.' ? '  (tap)' : String(Math.round(s.length / dur)).padStart(7);
  console.log(`${s.id}  ${s.letter.padEnd(6)}  ${s.name.padEnd(14)}  ${s.length.toFixed(2).padStart(6)}  ${slot.at.toFixed(2)}   ${dur.toFixed(2)}  ${speed}`);
}
for (const st of strokes) if (st.turns) console.log(`turns ${st.id}: ${st.turns.map((t) => `s ${t.s} (${t.angle} deg, speed ${t.speed})`).join(', ')}`);
console.log('drip    paint lands  starts  stops');
for (const d of drips) {
  console.log(`${d.id}  ${d.landed.toFixed(2).padStart(11)}  ${d.start.toFixed(2).padStart(6)}  ${(d.start + dripDuration(d.beadY - d.top)).toFixed(2).padStart(5)}`);
}
console.log(`points: ${strokes.reduce((n, s) => n + s.points.length / 2, 0)}, mask ${W}x${H} over ${R.w}x${R.h} units`);
