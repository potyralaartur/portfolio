/**
 * Composite: paint buffer -> screen. The white core and fog come per stroke
 * (one density per mask channel, paint.ts) and combine here: the core by max,
 * so an overlap is no denser than either stroke; the fog by max plus
 * look.composite.fogOverlap of the rest, so a join isn't fogged twice. Paint builds up: alpha = 1 - exp(-k * density),
 * colour fixed at the paint colour (never brighter, only more opaque). Orange
 * is its own channel and always sits over white, never mixed into pink.
 * Premultiplied output (the canvas is premultipliedAlpha). Wetness (B) is not
 * shown: paint lands and stays. Overspray: the fog and the core's edge turn
 * into droplets, round dots drawn procedurally in logo space at the canvas's
 * resolution (notes §5: grainy, not smooth), static (§3), keeping the fog's
 * mean. Drips are drawn here too, as antialiased shapes (DripEmitter.state).
 * Scroll: the paint is dragged up (the way the page moves), thinning where it leaves,
 * then it all fades, fog first; at uScroll 0 the output is untouched.
 * At rest the finished drawing is baked into a texture at the canvas size
 * (bake()); the canvas keeps showing it, and the scroll effect runs on it.
 */
import {
  DataTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  NoBlending,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Texture,
} from 'three';
import type { Engine } from './engine';
import { look, VIEW } from './look';
import { FULLSCREEN_VERT, fullscreenTriangle, NOISE_GLSL } from './paint';
import type { DripState } from './splats';

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
#define RUN_TAPS ${look.scroll.run.taps}
uniform sampler2D uPaint;
uniform sampler2D uCore; // white core, one stroke colour per channel (RGB)
uniform sampler2D uFog; // white fog (mist, halo), likewise
uniform float uFogOverlap;
uniform sampler2D uBaked; // the finished drawing at canvas size, premultiplied (bake())
uniform bool uAtRest; // show uBaked instead of the paint buffers
uniform sampler2D uGrain;
uniform vec4 uView; // left, top, width, height of the buffer in logo units
uniform float uGrainCell; // grain cell size, logo units (scroll fade)
uniform float uAa; // logo units per device pixel: antialiasing width
// Overspray droplets (look.overspray): per octave cell, dot radius min / max (x cell), weight
uniform vec4 uDrop[3];
uniform vec4 uDropShape; // haze, cell scale (minPx), fogLo, fogHi
uniform float uDotAlpha;
// Drips (DripEmitter.state): x, top, bead bottom, bead radius (0 = off)
uniform vec4 uDrip[5];
// trail width, neck 0..1, stretch, length top to bead centre
uniform vec4 uDripShape[5];
uniform vec2 uDripMeta[5]; // orange, seed
uniform vec4 uDripLook0; // wander, wanderLen, straight, widthVar
uniform vec4 uDripLook1; // taper top, taper bottom, widthLen, inset
uniform vec4 uDripLook2; // neck width, neck length, smooth, bead aspect
uniform float uDripAlpha;
uniform vec3 uWhite;
uniform vec3 uOrange;
uniform float uK;
// Scroll (look.scroll): uScroll 0..1 and the effect's shape
uniform float uScroll;
uniform vec2 uRunRange;
uniform vec4 uRun; // max, column, coarse, power
uniform vec4 uSmear; // floor, decay, drag, streak cell
uniform vec4 uSmearShape; // film lo, film hi, line crispness, line length spread
uniform vec2 uRunTail; // drag-line depth (0 even .. 1 only on lines), top fade (units)
uniform vec2 uFadeRange;
uniform float uFadeGrain;
uniform vec2 uFadeShape; // streak segment length (units), drag-line weight
in vec2 vUv;
out vec4 color;

${NOISE_GLSL}

float coverage(float d) {
  return 1.0 - exp(-uK * d);
}

// Overspray droplets on partially transparent paint only: solid paint stays
// solid. In each octave's cell one round dot, present with probability q, so
// the droplets' mean is the droplet share of alpha a; the haze makes up the
// rest exactly (more of it where q saturates).
float droplets(float a, vec2 world, int seed) {
  if (a <= 0.0) return a;
  float fog = 1.0 - smoothstep(uDropShape.z, uDropShape.w, a);
  if (fog <= 0.0) return a;
  float share = a * (1.0 - uDropShape.x);
  float miss = 1.0; // 1 - dot coverage here
  float missMean = 1.0; // its expected value
  for (int i = 0; i < 3; i++) {
    vec4 o = uDrop[i];
    float cell = o.x * uDropShape.y;
    // Mean dot area as a share of the cell (radius uniform in [min, max])
    float area = 3.14159265 * (o.z * o.z * o.z - o.y * o.y * o.y) / (3.0 * (o.z - o.y)) * uDotAlpha;
    float q = min(1.0, share * o.w / area);
    missMean *= 1.0 - q * area;
    vec2 g = world / cell;
    vec4 h = hash4(ivec2(floor(g)), seed, i);
    if (h.x >= q) continue;
    float rf = mix(o.y, o.z, h.y);
    vec2 centre = rf + (1.0 - 2.0 * rf) * h.zw; // the whole dot inside its cell
    float r = rf * cell;
    float dist = length(fract(g) - centre) * cell;
    // Antialiased disc; sub-pixel dots stay a pixel wide and fainter (same area)
    float re = max(r, 0.5 * uAa);
    float cov = (1.0 - smoothstep(re - 0.5 * uAa, re + 0.5 * uAa, dist)) * (r * r) / (re * re);
    miss *= 1.0 - cov * uDotAlpha;
  }
  float dots = 1.0 - missMean;
  float haze = max(0.0, (a - dots) / max(1e-4, 1.0 - dots));
  return mix(a, 1.0 - (1.0 - haze) * miss, fog);
}

// Ellipse, approximate signed distance
float ellipse(vec2 p, vec2 r) {
  return (length(p / r) - 1.0) * min(r.x, r.y);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// A drip's coverage at world: a trail that leaves the letter through a neck,
// tapers and drifts a little as it runs, and a teardrop bead at its end
float drip(vec2 world, int i) {
  vec4 d = uDrip[i];
  if (d.w <= 0.0) return 0.0;
  vec4 s = uDripShape[i];
  float x = d.x, top = d.y, bottom = d.z, br = d.w;
  float y0 = top - uDripLook1.w;
  float ry = br * uDripLook2.w * (1.0 + s.z);
  float centre = bottom - ry; // bead stretched upward from its bottom
  if (world.y < y0 - 2.0 || world.y > bottom + 1.0 || abs(world.x - x) > 4.0) return 0.0;
  int seed = int(uDripMeta[i].y * 1000.0);
  // Trail: centre line and radius as functions of y only, so a laid trail never shifts
  float yy = clamp(world.y, y0, centre);
  float below = max(yy - top, 0.0);
  float cx = x + uDripLook0.x * (2.0 * vnoise1(yy / uDripLook0.y, seed) - 1.0) * smoothstep(0.0, uDripLook0.z, below);
  float u = clamp(below / max(s.w, 1e-3), 0.0, 1.0);
  float w = 0.5 * s.x * mix(uDripLook1.x, uDripLook1.y, u) * (1.0 + uDripLook0.w * (2.0 * vnoise1(yy / uDripLook1.z, seed + 1) - 1.0));
  w += s.x * uDripLook2.x * exp(-below / uDripLook2.y) * s.y;
  float trail = length(vec2(world.x - cx, world.y - yy)) - w;
  // Bead: follows the trail's drift at its centre
  float bx = x + uDripLook0.x * (2.0 * vnoise1(centre / uDripLook0.y, seed) - 1.0) * smoothstep(0.0, uDripLook0.z, max(centre - top, 0.0));
  float bead = ellipse(world - vec2(bx, centre), vec2(br, ry));
  float sdf = smin(trail, bead, uDripLook2.z * br);
  return clamp(0.5 - sdf / uAa, 0.0, 1.0);
}

vec2 toWorld(vec2 uv) {
  return vec2(uView.x + uv.x * uView.z, uView.y + (1.0 - uv.y) * uView.w);
}

vec2 toUv(vec2 world) {
  return vec2((world.x - uView.x) / uView.z, 1.0 - (world.y - uView.y) / uView.w);
}

float grainAt(vec2 world) {
  return texture(uGrain, world / (uGrainCell * float(textureSize(uGrain, 0).x))).r;
}

// What the canvas shows without scroll: the paint, or at rest its baked copy
vec4 source(vec2 uv) {
  if (uAtRest) return texture(uBaked, uv);
  vec4 p = texture(uPaint, uv);
  vec3 c = texture(uCore, uv).rgb;
  vec3 f = texture(uFog, uv).rgb;
  float fMax = max(max(f.r, f.g), f.b);
  // The strokes, combined: the core as dense as its densest stroke, the fog
  // mostly so; speckle and drips (in p.r) on top
  p.r += max(max(c.r, c.g), c.b) + fMax + uFogOverlap * (f.r + f.g + f.b - fMax);
  vec2 world = toWorld(uv);
  float w = droplets(coverage(p.r), world, 1);
  float o = droplets(coverage(p.g), world, 2);
  // Drips: solid paint, antialiased at this resolution (their edge gets no droplets)
  for (int i = 0; i < 5; i++) {
    float c = drip(world, i) * uDripAlpha;
    if (uDripMeta[i].x > 0.5) o = 1.0 - (1.0 - o) * (1.0 - c);
    else w = 1.0 - (1.0 - w) * (1.0 - c);
  }
  // Orange sits on top of white; premultiplied
  return vec4(uOrange * o + uWhite * w * (1.0 - o), o + w * (1.0 - o));
}

float hash(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

// Smooth seeded value noise along x: which columns run, and how far
float columnNoise(float x) {
  float a = x / uRun.y;
  float fa = fract(a);
  float fine = mix(hash(floor(a)), hash(floor(a) + 1.0), fa * fa * (3.0 - 2.0 * fa));
  float b = x / uRun.z;
  float fb = fract(b);
  float coarse = mix(hash(floor(b) + 71.0), hash(floor(b) + 72.0), fb * fb * (3.0 - 2.0 * fb));
  return clamp(0.55 * fine + 0.45 * coarse, 0.0, 1.0);
}

void main() {
  // No scroll: untouched
  if (uScroll <= 0.0) {
    color = source(vUv);
    return;
  }
  vec2 world = toWorld(vUv);

  // The paint is dragged up as the page scrolls down, as if wiped while wet:
  // each pixel keeps part of its paint and takes on paint pulled up from
  // below it, more from nearby than far (an exponential trail up to \`len\`).
  // Where paint is pulled from, the letter thins, so nothing is doubled.
  // How much moves varies across x in fine drag lines; how far, in wider bands.
  float runProgress = smoothstep(uRunRange.x, uRunRange.y, uScroll);
  // Drag lines: fine, uneven streaks across x (bristles, fingertips), crisp-sided
  float lineNoise = 0.65 * vnoise1(world.x / uSmear.w, 21) + 0.35 * vnoise1(world.x / (uSmear.w * 0.37), 22);
  float lines = smoothstep(0.5 - uSmearShape.z, 0.5 + uSmearShape.z, lineNoise);
  // Length: wide bands, and each fine line stops at its own height (ragged ends)
  float lineLen = 1.0 + uSmearShape.w * (2.0 * vnoise1(world.x / (uSmear.w * 0.8), 23) - 1.0);
  float len = runProgress * uRun.x * lineLen * (uSmear.x + (1.0 - uSmear.x) * pow(columnNoise(world.x), uRun.w));
  vec4 here = source(vUv);
  vec4 c = here;
  if (len > 0.0) {
    float decay = max(len * uSmear.y, 1e-3);
    float span = 1.0 - exp(-len / decay);
    // Taps spread by the trail's own falloff (equal weights), jittered per device pixel (static)
    float jitter = hash4(ivec2(floor(world / uAa)), 7, 0).x;
    vec4 trail = vec4(0.0);
    for (int i = 0; i < RUN_TAPS; i++) {
      float u = (float(i) + jitter) / float(RUN_TAPS);
      trail += source(toUv(world + vec2(0.0, -decay * log(1.0 - u * span))));
    }
    trail /= float(RUN_TAPS);
    // Wet film: a dragged trail stays fairly solid, then breaks off, instead of blurring out
    float film = smoothstep(uSmearShape.x, uSmearShape.y, trail.a);
    trail *= film / max(trail.a, 1e-4);
    float drag = runProgress * uSmear.z * (1.0 - uRunTail.x + uRunTail.x * lines);
    c = here * (1.0 - drag) + trail * drag;
  }

  // Wiped off: each pixel goes when the fade passes its threshold. Paint
  // breaks up into short streak segments along the drag (noise stretched
  // along y), sooner between the drag lines, thin paint before dense; a fine
  // dither keeps the front from being a hard contour
  float f = clamp((uScroll - uFadeRange.x) / (uFadeRange.y - uFadeRange.x), 0.0, 1.0) * 1.1;
  vec2 sn = vnoise2(world / vec2(uSmear.w * 0.7, uFadeShape.x), 31);
  float segments = 0.6 * sn.x + 0.4 * vnoise2(world / vec2(uSmear.w * 1.6, uFadeShape.x * 0.45), 32).y;
  float pattern = mix(segments, lines, uFadeShape.y);
  float threshold = uFadeGrain * grainAt(world) + (1.0 - uFadeGrain) * (0.5 * pattern + 0.5 * c.a);
  c *= 1.0 - smoothstep(threshold - 0.2, threshold + 0.05, f);

  // Smears fade out near the canvas top instead of stopping at its edge
  // (eased in with the smear, so the first scroll pixel changes nothing)
  c *= mix(1.0, smoothstep(uView.y, uView.y + uRunTail.y, world.y), runProgress);
  color = c;
}`;

export interface PaintTextures {
  texture: Texture;
  core: Texture;
  fog: Texture;
}

export interface Composite {
  /** 0 at rest (the source untouched) .. 1 gone */
  setScroll(value: number): void;
  /** The drips, up to 5 (null = not started) */
  setDrips(list: (DripState | null)[]): void;
  /** The finished drawing into a texture at the canvas size; render(null) shows it from then on */
  bake(paint: PaintTextures): void;
  /** From the paint buffers (paint.ts), or null: from the baked drawing */
  render(paint: PaintTextures | null): void;
  dispose(): void;
}

export function createComposite(engine: Engine, grainTex: Texture): Composite {
  const c = look.composite;
  const sc = look.scroll;
  const dr = look.drips;
  const ov = look.overspray;
  const drips = Array.from({ length: 5 }, () => new Vector4());
  const dripShapes = Array.from({ length: 5 }, () => new Vector4());
  const dripMeta = Array.from({ length: 5 }, () => new Vector2());
  // Stands in for a texture that isn't there (the baked drawing before bake(), the paint once disposed)
  const blank = new DataTexture(new Uint8Array(4), 1, 1);
  blank.needsUpdate = true;
  let baked: WebGLRenderTarget | null = null;
  const mat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: COMPOSITE_FRAG,
    uniforms: {
      uPaint: { value: null },
      uCore: { value: null },
      uFog: { value: null },
      uFogOverlap: { value: c.fogOverlap },
      uBaked: { value: blank },
      uAtRest: { value: false },
      uGrain: { value: grainTex },
      uView: { value: [VIEW.left, VIEW.top, VIEW.right - VIEW.left, VIEW.bottom - VIEW.top] },
      uGrainCell: { value: Math.max(look.grain.size, 0.1) }, // set on resize
      uAa: { value: 0.1 },
      uDrop: { value: ov.octaves.map((o) => new Vector4(o.cell, o.r[0], o.r[1], o.weight)) },
      uDropShape: { value: new Vector4(ov.haze, 1, ov.fogLo, ov.fogHi) },
      uDotAlpha: { value: ov.dotAlpha },
      uDrip: { value: drips },
      uDripShape: { value: dripShapes },
      uDripMeta: { value: dripMeta },
      uDripLook0: { value: [dr.wander, dr.wanderLen, dr.straight, dr.widthVar] },
      uDripLook1: { value: [dr.taper[0], dr.taper[1], dr.widthLen, dr.inset] },
      uDripLook2: { value: [dr.neck.w, dr.neck.len, dr.smooth, dr.beadAspect] },
      uDripAlpha: { value: dr.alpha },
      uWhite: { value: c.white },
      uOrange: { value: c.orange },
      uK: { value: c.k },
      uScroll: { value: 0 },
      uRunRange: { value: sc.run.range },
      uRun: { value: [sc.run.max, sc.run.column, sc.run.coarse, sc.run.power] },
      uSmear: { value: [sc.run.floor, sc.run.decay, sc.run.drag, sc.run.lines] },
      uSmearShape: { value: [sc.run.film[0], sc.run.film[1], sc.run.crisp, sc.run.lineLength] },
      uRunTail: { value: [sc.run.depth, sc.run.topFade] },
      uFadeRange: { value: sc.fade.range },
      uFadeGrain: { value: sc.fade.grain },
      uFadeShape: { value: [sc.fade.segment, sc.fade.lines] },
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(fullscreenTriangle(), mat);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  // Antialiasing width; droplet and grain cells never smaller than their minPx device pixels (at 390 wide 1 unit ~ 1.4 px)
  const offResize = engine.onResize((w) => {
    const unitsPerPx = (VIEW.right - VIEW.left) / w;
    mat.uniforms.uAa.value = unitsPerPx;
    mat.uniforms.uDropShape.value.y = Math.max(1, (ov.minPx * unitsPerPx) / ov.octaves[0].cell);
    mat.uniforms.uGrainCell.value = Math.max(look.grain.size, look.grain.minPx * unitsPerPx);
  });

  function use(paint: PaintTextures | null) {
    mat.uniforms.uAtRest.value = !paint;
    mat.uniforms.uPaint.value = paint?.texture ?? blank;
    mat.uniforms.uCore.value = paint?.core ?? blank;
    mat.uniforms.uFog.value = paint?.fog ?? blank;
  }

  return {
    setScroll(value) {
      mat.uniforms.uScroll.value = value;
    },
    setDrips(list) {
      for (let i = 0; i < 5; i++) {
        const d = list[i];
        drips[i].set(d?.x ?? 0, d?.top ?? 0, d?.bottom ?? 0, d?.beadR ?? 0);
        dripShapes[i].set(d?.width ?? 0, d?.neck ?? 0, d?.stretch ?? 0, d?.length ?? 1);
        dripMeta[i].set(d?.orange ? 1 : 0, d?.seed ?? 0);
      }
    },
    bake(paint) {
      const { width, height } = engine.size;
      if (!baked || baked.width !== width || baked.height !== height) {
        baked?.dispose();
        baked = new WebGLRenderTarget(width, height, {
          type: UnsignedByteType, // what the canvas holds: texel for pixel the same
          format: RGBAFormat,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        });
      }
      const scroll = mat.uniforms.uScroll.value;
      mat.uniforms.uScroll.value = 0;
      use(paint);
      engine.renderer.setRenderTarget(baked);
      engine.renderer.render(scene, engine.camera);
      engine.renderer.setRenderTarget(null);
      mat.uniforms.uScroll.value = scroll;
      mat.uniforms.uBaked.value = baked.texture;
    },
    render(paint) {
      use(paint);
      engine.renderer.setRenderTarget(null);
      engine.renderer.render(scene, engine.camera);
    },
    dispose() {
      offResize();
      baked?.dispose();
      blank.dispose();
      mat.dispose();
      mesh.geometry.dispose();
    },
  };
}
