/**
 * Paint buffer. Two ping-pong render targets in logo space (the SVG box):
 *   R = white density, G = orange density, B = wetness (decays, ~1.5 s).
 * Per frame, into the write target: (1) copy previous with wetness decay,
 * (2) one InstancedMesh of soft round splats, additive. Then swap.
 * The white strokes' core and fog go to their own targets instead (no decay,
 * so no ping-pong): each stroke keeps its own density in its mask channel
 * (R, G, B of stroke-masks.png), its core clipped by its own mask. The
 * composite combines the strokes, so an overlap isn't painted or fogged twice.
 * The paint buffer keeps the orange (full stop), speckle and wetness (drips are drawn by the composite).
 */
import {
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  NearestFilter,
  Mesh,
  NoBlending,
  OneFactor,
  PlaneGeometry,
  RawShaderMaterial,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Texture,
  WebGLRenderTarget,
} from 'three';
import type { Engine } from './engine';
import { look, MASK_RECT, VIEW } from './look';
import { ODD_PART, SPLAT_FLOATS } from './splats';

/** Full-screen triangle; vertex shaders pass it straight to clip space */
export function fullscreenTriangle() {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

export const FULLSCREEN_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * Static noise in logo space, shared by the splat and composite shaders.
 * Integer hash (pcg4d, Jarzynski & Olano 2020): the same on every GPU, so the
 * same grain every play. Inputs are offset so they stay positive.
 */
export const NOISE_GLSL = /* glsl */ `
precision highp int; // 32-bit hashing (fragment ints default to mediump)
uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
// Four hashes 0..1 for an integer cell and two seeds
vec4 hash4(ivec2 cell, int a, int b) {
  return vec4(pcg4d(uvec4(ivec4(cell + 65536, a, b)))) / 4294967295.0;
}
// Smooth value noise, 0..1: two independent channels
vec2 vnoise2(vec2 p, int seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  vec2 a = hash4(c, seed, 0).xy;
  vec2 b = hash4(c + ivec2(1, 0), seed, 0).xy;
  vec2 d = hash4(c + ivec2(0, 1), seed, 0).xy;
  vec2 e = hash4(c + ivec2(1, 1), seed, 0).xy;
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float vnoise1(float x, int seed) {
  float i = floor(x);
  float f = fract(x);
  ivec2 c = ivec2(int(i), 0);
  return mix(hash4(c, seed, 1).x, hash4(c + ivec2(1, 0), seed, 1).x, f * f * (3.0 - 2.0 * f));
}`;

const DECAY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform float uDecay;
in vec2 vUv;
out vec4 color;
void main() {
  vec4 p = texture(uPrev, vUv);
  float wet = p.b * uDecay;
  color = vec4(p.rg, wet < 0.004 ? 0.0 : wet, 0.0);
}`;

const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
in vec2 vUv;
out vec4 color;
void main() {
  color = texture(uPrev, vUv);
}`;

const SPLAT_VERT = /* glsl */ `
in vec3 position;
in mat4 instanceMatrix;
in vec4 aParams; // alpha, hardness, target (splats.ts SPLAT_FLOATS), orange
in float aWet;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float uMinR; // logo units per look.speckle.minPx device px: tiny dots stay visible
uniform highp int uPass; // 0: the paint buffer, 1: white core, 2: white fog
out vec2 vLocal;
out vec2 vWorld;
out vec4 vParams;
out float vWet;
void main() {
  // Splats for another pass go off screen: no fragments
  float target = aParams.z;
  bool white = aParams.w < 0.5;
  bool mine = uPass == 1 ? target > 0.5 && white : uPass == 2 ? target < -0.5 : target > -0.5; // fog is dry: pass 0 skips it
  if (!mine) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float r = length(instanceMatrix[0].xy) * 0.5;
  float grow = max(1.0, uMinR / max(r, 1e-4));
  vec4 world = instanceMatrix * vec4(position.xy * grow, 0.0, 1.0);
  vLocal = position.xy * 2.0; // -1..1
  vWorld = world.xy;
  vParams = aParams;
  vWet = aWet;
  gl_Position = projectionMatrix * modelViewMatrix * world;
}`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;
#define ODD_PART ${ODD_PART.toFixed(1)}
uniform sampler2D uMasks; // stroke-masks.png over MASK_RECT: RGB one per stroke colour, A strokes' odd parts
uniform vec2 uRough; // edge roughness, wobble cell (logo units)
uniform vec4 uMaskRect; // x, y, w, h in logo units (MASK_RECT)
uniform vec2 uClip; // smoothstep window on the soft mask: density can't push the edge outward
uniform highp int uPass; // 0: the paint buffer, 1: white core, 2: white fog
in vec2 vLocal;
in vec2 vWorld;
in vec4 vParams;
in float vWet;
out vec4 color;
${NOISE_GLSL}
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  // Gaussian with sigma = radius / 3, faded out over the last 10 %
  float puff = exp(-r * r * 4.5) * (1.0 - smoothstep(0.9, 1.0, r));
  float disc = 1.0 - smoothstep(0.8, 1.0, r);
  float a = vParams.x * mix(puff, disc, vParams.y);
  bool clipped = vParams.z > 0.5;
  bool whiteCore = clipped && vParams.w < 0.5;
  // This stroke's channel (core or fog), and the mask of the part laying it
  bool odd = vParams.z > ODD_PART;
  int ch = int(abs(vParams.z) - (odd ? ODD_PART : 0.0) + 0.5) - 1;
  vec3 sel = vec3(ch == 0, ch == 1, ch == 2);
  vec4 maskSel = odd ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(sel, 0.0);
  if (uPass == 2) {
    color = vec4(sel * a, 0.0);
    return;
  }
  if (clipped) {
    // This stroke's own mask only: it never paints another stroke's shape
    // Rough edge: a static, smooth wobble of the mask lookup (Figma core "Texture"); the grit is the composite's droplets
    vec2 jitter = 0.67 * vnoise2(vWorld / uRough.y, 11) + 0.33 * vnoise2(vWorld * 2.0 / uRough.y, 12) - 0.5;
    vec2 uv = (vWorld + jitter * uRough.x - uMaskRect.xy) / uMaskRect.zw;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    a *= smoothstep(uClip.x, uClip.y, dot(texture(uMasks, uv), maskSel)) * inside;
  }
  if (uPass == 1) {
    // The white core: this stroke's density in its channel
    color = vec4(sel * a, 0.0);
    return;
  }
  // The white core only wets the paint buffer; its density is in the core target
  float d = whiteCore ? 0.0 : a;
  color = vec4(d * (1.0 - vParams.w), d * vParams.w, a * vWet, 0.0);
}`;

export interface Paint {
  readonly texture: Texture;
  /** Current (read) target, for dev readback */
  readonly target: WebGLRenderTarget;
  /** The white strokes' core, one density per mask channel (RGB); the composite combines them */
  readonly core: WebGLRenderTarget;
  /** The white strokes' fog (mist, halo), likewise */
  readonly fog: WebGLRenderTarget;
  readonly halfFloat: boolean;
  /** Low tier: 8-bit buffers (the paint is resampled, nothing is lost that 8-bit can show) */
  setHalfFloat(on: boolean): void;
  /** Queue splats (SPLAT_FLOATS each) for the next step */
  readonly batch: { data: Float32Array; count: number; capacity: number };
  /** Decay + splats into the buffer. dt in seconds. */
  step(dt: number): void;
  /** Wetness still visible (keeps frames coming after the last splat) */
  readonly wetFor: number;
  clear(): void;
  dispose(): void;
}

export function createPaint(engine: Engine, masks: Texture): Paint {
  const { renderer, camera } = engine;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const canHalf = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  let halfFloat = look.tiers[engine.tier].halfFloat && canHalf;

  const makeTarget = (w: number, h: number) =>
    new WebGLRenderTarget(w, h, {
      type: halfFloat ? HalfFloatType : UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

  let read = makeTarget(1, 1);
  let write = makeTarget(1, 1);
  let core = makeTarget(1, 1);
  let fog = makeTarget(1, 1);

  // (1) copy + decay
  const decayMat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: DECAY_FRAG,
    uniforms: { uPrev: { value: read.texture }, uDecay: { value: 1 } },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const decayScene = new Scene();
  const decayMesh = new Mesh(fullscreenTriangle(), decayMat);
  decayMesh.frustumCulled = false;
  decayScene.add(decayMesh);
  // Resampling the core and fog targets into a new size or type (they have no wetness)
  const copyMat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: COPY_FRAG,
    uniforms: { uPrev: { value: null } },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const copyScene = new Scene();
  const copyMesh = new Mesh(decayMesh.geometry, copyMat);
  copyMesh.frustumCulled = false;
  copyScene.add(copyMesh);

  // (2) splats: one InstancedMesh, matrix = translate + scale
  const capacity = look.maxSplatsPerFrame;
  const quad = new PlaneGeometry(1, 1);
  const params = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
  const wet = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
  quad.setAttribute('aParams', params);
  quad.setAttribute('aWet', wet);
  const splatMat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: SPLAT_VERT,
    fragmentShader: SPLAT_FRAG,
    uniforms: {
      uMasks: { value: masks },
      uMaskRect: { value: [MASK_RECT.x, MASK_RECT.y, MASK_RECT.w, MASK_RECT.h] },
      uClip: { value: look.mask.clip },
      uRough: { value: [look.mask.roughness, look.mask.roughCell] },
      uPass: { value: 0 },
      uMinR: { value: 0 },
    },
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const splats = new InstancedMesh(quad, splatMat, capacity);
  splats.instanceMatrix.setUsage(DynamicDrawUsage);
  splats.frustumCulled = false;
  splats.count = 0;
  const splatScene = new Scene();
  splatScene.add(splats);

  const batch = { data: new Float32Array(capacity * SPLAT_FLOATS), count: 0, capacity };
  let wetFor = 0;

  function uploadBatch() {
    const n = batch.count;
    const m = splats.instanceMatrix.array as Float32Array;
    const pa = params.array as Float32Array;
    const wa = wet.array as Float32Array;
    const d = batch.data;
    for (let i = 0; i < n; i++) {
      const o = i * SPLAT_FLOATS;
      // Rotated ellipse: major axis = diameter, minor axis squeezed by aspect
      const sx = d[o + 2] * 2;
      const sy = sx / d[o + 9];
      const c = Math.cos(d[o + 8]);
      const sn = Math.sin(d[o + 8]);
      const mo = i * 16;
      m.fill(0, mo, mo + 16);
      m[mo] = c * sx;
      m[mo + 1] = sn * sx;
      m[mo + 4] = -sn * sy;
      m[mo + 5] = c * sy;
      m[mo + 10] = 1;
      m[mo + 12] = d[o];
      m[mo + 13] = d[o + 1];
      m[mo + 15] = 1;
      pa[i * 4] = d[o + 3];
      pa[i * 4 + 1] = d[o + 4];
      pa[i * 4 + 2] = d[o + 5];
      pa[i * 4 + 3] = d[o + 6];
      wa[i] = d[o + 7];
    }
    splats.count = n;
    for (const attr of [splats.instanceMatrix, params, wet]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    batch.count = 0;
    if (n) wetFor = look.wet.tau * 3;
  }

  function pass(copyOnly: boolean, dt: number) {
    decayMat.uniforms.uPrev.value = read.texture;
    decayMat.uniforms.uDecay.value = copyOnly ? 1 : Math.exp(-dt / look.wet.tau);
    renderer.setRenderTarget(write);
    renderer.render(decayScene, camera);
    if (!copyOnly && splats.count) {
      splatMat.uniforms.uPass.value = 0;
      renderer.render(splatScene, camera);
      // Same splats again: the white core and fog, each stroke into its own channel
      for (const [pass, target] of [[1, core], [2, fog]] as const) {
        renderer.setRenderTarget(target);
        splatMat.uniforms.uPass.value = pass;
        renderer.render(splatScene, camera);
      }
    }
    renderer.setRenderTarget(null);
    [read, write] = [write, read];
  }

  /** New targets (size, type), keeping the paint: the old buffers are resampled into them */
  function rebuild(bw: number, bh: number) {
    const old = read;
    write.dispose();
    write = makeTarget(bw, bh);
    pass(true, 0); // old -> new (now in read)
    old.dispose();
    write = makeTarget(bw, bh);
    core = resample(core, bw, bh);
    fog = resample(fog, bw, bh);
  }

  function resample(old: WebGLRenderTarget, bw: number, bh: number) {
    const next = makeTarget(bw, bh);
    copyMat.uniforms.uPrev.value = old.texture;
    renderer.setRenderTarget(next);
    renderer.render(copyScene, camera);
    renderer.setRenderTarget(null);
    old.dispose();
    return next;
  }

  const offResize = engine.onResize((w, h) => {
    const scale = Math.min(1, look.buffer.maxWidth / w);
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    // Minimum splat radius: look.speckle.minPx buffer pixels, in logo units
    const unitsPerPx = (VIEW.right - VIEW.left) / bw;
    splatMat.uniforms.uMinR.value = look.speckle.minPx * unitsPerPx;
    if (bw !== read.width || bh !== read.height) rebuild(bw, bh);
  });

  const paint: Paint = {
    get texture() {
      return read.texture;
    },
    get target() {
      return read;
    },
    get core() {
      return core;
    },
    get fog() {
      return fog;
    },
    get halfFloat() {
      return halfFloat;
    },
    setHalfFloat(on) {
      const next = on && canHalf;
      if (next === halfFloat) return;
      halfFloat = next;
      rebuild(read.width, read.height);
    },
    batch,
    step(dt) {
      uploadBatch();
      // Last wet frame dries the buffer fully, so an idle buffer never depends on frame timing
      const dry = wetFor > 0 && wetFor <= dt;
      pass(false, dry ? Infinity : dt);
      wetFor = Math.max(0, wetFor - dt);
    },
    get wetFor() {
      return wetFor;
    },
    clear() {
      for (const t of [read, write, core, fog]) {
        renderer.setRenderTarget(t);
        renderer.clear();
      }
      renderer.setRenderTarget(null);
      batch.count = 0;
      splats.count = 0;
      wetFor = 0;
    },
    dispose() {
      offResize();
      read.dispose();
      write.dispose();
      core.dispose();
      fog.dispose();
      decayMat.dispose();
      copyMat.dispose();
      decayMesh.geometry.dispose();
      splatMat.dispose();
      quad.dispose();
      splats.dispose();
    },
  };
  return paint;
}

/** Single-channel data texture from a PNG: top row first, no mips, linear data (no colour conversion) */
export async function loadTexture(url: string, opts: { repeat?: boolean; nearest?: boolean } = {}): Promise<Texture> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const tex = new Texture(bitmap);
  tex.flipY = false; // ImageBitmaps can't be flipped on upload; uv.y = 0 is the top row
  tex.generateMipmaps = false;
  tex.minFilter = opts.nearest ? NearestFilter : LinearFilter;
  tex.magFilter = opts.nearest ? NearestFilter : LinearFilter;
  if (opts.repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
