/**
 * Cursor smear field: where the pointer has dragged the wet paint. A small
 * ping-pong target in logo space over VIEW (the paint's own box), half-float:
 *   RG = displacement D, logo units (the composite shows the paint from p - D)
 *   B  = strength 0..1 (the composite dissolves the smear as it falls)
 *   A  = hold, seconds left before it starts to fall
 * Each pointer move adds its motion under a soft round brush and carries the
 * field along with it (advection), so paint travels the whole path like a
 * finger through wet paint. Untouched, a texel holds for look.smear.cursor.hold,
 * then its strength falls over `fade`; at 0 its displacement is dropped.
 * Smooth data: a low resolution is enough (bilinear in the composite). A
 * long move (a flick) is laid in short steps, each well under the brush
 * radius, so the carried paint never folds over itself.
 */
import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type Texture,
} from 'three';
import type { Engine } from './engine';
import { look, VIEW } from './look';
import { FULLSCREEN_VERT, fullscreenTriangle } from './paint';

const UPDATE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform vec4 uView; // left, top, width, height in logo units
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uMove; // 1 when the pointer moved since the last frame
uniform float uRadius;
uniform float uPull;
uniform float uMaxLen;
uniform float uDt;
uniform float uHold;
uniform float uFade;
in vec2 vUv;
out vec4 color;

vec2 toWorld(vec2 uv) {
  return vec2(uView.x + uv.x * uView.z, uView.y + (1.0 - uv.y) * uView.w);
}

vec2 toUv(vec2 world) {
  return vec2((world.x - uView.x) / uView.z, 1.0 - (world.y - uView.y) / uView.w);
}

// Soft round brush along the segment the pointer covered: 1 on it, 0 at uRadius
float brush(vec2 p) {
  vec2 ab = uTo - uFrom;
  float t = clamp(dot(p - uFrom, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float x = clamp(length(p - uFrom - ab * t) / uRadius, 0.0, 1.0);
  float b = 1.0 - x * x;
  return uMove * b * b;
}

void main() {
  vec2 p = toWorld(vUv);
  float w = brush(p);
  vec2 delta = w * (uTo - uFrom) * uPull;
  // The field moves with the paint it carries
  vec4 prev = texture(uPrev, toUv(p - delta));
  vec2 d = prev.xy + delta;
  float len = length(d);
  if (len > uMaxLen) d *= uMaxLen / len;
  // Strength and hold stay put (not carried): the whole swipe falls evenly, no texel blocks
  vec4 here = texture(uPrev, vUv);
  float strength = here.z;
  float hold = here.w;
  // Full strength over most of the brush, easing out at its rim (no texel steps at the edge)
  float touch = smoothstep(0.0, 0.3, w);
  if (touch > 0.0) {
    strength = max(strength, touch);
    hold = uHold;
  } else if (hold > 0.0) {
    hold = max(hold - uDt, 0.0);
  } else {
    strength = max(strength - uDt / uFade, 0.0);
  }
  if (strength <= 0.0) d = vec2(0.0);
  color = vec4(d, strength, hold);
}`;

export interface Smear {
  /** The field (composite uField) */
  readonly texture: Texture;
  /** Something is still smeared: keep drawing frames */
  readonly active: boolean;
  /** The pointer moved from -> to (logo units) since the last update */
  move(from: { x: number; y: number }, to: { x: number; y: number }): void;
  /** One step: the queued move, the hold and the fade. dt in seconds. */
  update(dt: number): void;
  dispose(): void;
}

/** null when half-float targets can't be rendered to: then there's no cursor smear */
export function createSmear(engine: Engine): Smear | null {
  const { renderer, camera } = engine;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return null;

  const cfg = look.smear.cursor;
  const width = cfg.field;
  const height = Math.round((width * (VIEW.bottom - VIEW.top)) / (VIEW.right - VIEW.left));
  const makeTarget = () =>
    new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  let read = makeTarget();
  let write = makeTarget();
  for (const t of [read, write]) {
    renderer.setRenderTarget(t);
    renderer.clear();
  }
  renderer.setRenderTarget(null);

  const from = new Vector2();
  const to = new Vector2();
  const mat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: UPDATE_FRAG,
    uniforms: {
      uPrev: { value: read.texture },
      uView: { value: [VIEW.left, VIEW.top, VIEW.right - VIEW.left, VIEW.bottom - VIEW.top] },
      uFrom: { value: from },
      uTo: { value: to },
      uMove: { value: 0 },
      uRadius: { value: cfg.radius },
      uPull: { value: cfg.pull },
      uMaxLen: { value: cfg.maxLen },
      uDt: { value: 0 },
      uHold: { value: cfg.hold },
      uFade: { value: cfg.fade },
    },
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(fullscreenTriangle(), mat);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);

  let moved = false;
  /** Seconds since the pointer last moved; everything is gone by hold + fade */
  let since = Infinity;

  return {
    get texture() {
      return read.texture;
    },
    get active() {
      return moved || since < cfg.hold + cfg.fade + 0.05;
    },
    move(a, b) {
      // Several moves in one frame: one segment from the first to the last
      if (!moved) from.set(a.x, a.y);
      to.set(b.x, b.y);
      moved = true;
    },
    update(dt) {
      if (!this.active) return;
      since = moved ? 0 : since + dt;
      // Steps of at most maxStep x the radius (a flick: up to 48); the hold and fade advance once
      const steps = moved ? Math.min(48, Math.max(1, Math.ceil(from.distanceTo(to) / (cfg.maxStep * cfg.radius)))) : 1;
      const a = from.clone();
      const b = to.clone();
      for (let i = 0; i < steps; i++) {
        from.lerpVectors(a, b, i / steps);
        to.lerpVectors(a, b, (i + 1) / steps);
        mat.uniforms.uPrev.value = read.texture;
        mat.uniforms.uMove.value = moved ? 1 : 0;
        mat.uniforms.uDt.value = i === 0 ? dt : 0;
        renderer.setRenderTarget(write);
        renderer.render(scene, camera);
        [read, write] = [write, read];
      }
      renderer.setRenderTarget(null);
      moved = false;
    },
    dispose() {
      read.dispose();
      write.dispose();
      mat.dispose();
      mesh.geometry.dispose();
    },
  };
}
