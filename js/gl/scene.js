import * as THREE from "three";
import { createHeightCanvas, FLAT } from "./heightmap.js";
import {
  fullscreenVert,
  flowFrag,
  blurFrag,
  reliefBakeFrag,
  grainBakeFrag,
  reliefFrag,
  videoVert,
  videoFrag,
} from "./shaders.js";

const WALL_SPEED = 0.45; // wall parallax relative to page scroll
const HEIGHT_SIZE = 2048;
const FLOW_SIZE = 256;
const SWELL_COUNT = 6; // random swellings alive at once

const quad = new THREE.PlaneGeometry(1, 1);

function target(size, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    ...opts,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

function pass(fragmentShader, uniforms, defines = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(quad, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, material };
}

// ---------------------------------------------------------------------------
// Ping-pong flowmap the cursor paints into.
// ---------------------------------------------------------------------------
class Flowmap {
  constructor(renderer) {
    this.renderer = renderer;
    this.read = target(FLOW_SIZE);
    this.write = target(FLOW_SIZE);
    this.uniforms = {
      tPrev: { value: this.read.texture },
      uMouse: { value: new THREE.Vector2(-1, -1) },
      uVelocity: { value: new THREE.Vector2() },
      uGhost: { value: new THREE.Vector2(-1, -1) },
      uGhostAmount: { value: 0 },
      uAspect: { value: 1 },
      uFalloff: { value: 0.24 },
      uDissipation: { value: 0.955 },
      uDelta: { value: 1 },
      uShift: { value: 0 },
      uTime: { value: 0 },
      uSwells: { value: Array.from({ length: SWELL_COUNT }, () => new THREE.Vector4()) },
    };
    this.pass = pass(flowFrag, this.uniforms, { SWELL_COUNT });
    this.camera = new THREE.Camera();
    // start empty
    for (const rt of [this.read, this.write]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
    }
    renderer.setRenderTarget(null);
  }

  get texture() {
    return this.read.texture;
  }

  update() {
    this.uniforms.tPrev.value = this.read.texture;
    this.renderer.setRenderTarget(this.write);
    this.renderer.render(this.pass.scene, this.camera);
    this.renderer.setRenderTarget(null);
    [this.read, this.write] = [this.write, this.read];
  }
}

// ---------------------------------------------------------------------------
// The scene: plaster wall + video planes that follow DOM elements.
// ---------------------------------------------------------------------------
export class WallScene {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    // output is unconverted, so pass the plaster tone as raw values
    this.renderer.setClearColor(new THREE.Color().setRGB(0xe7 / 255, 0xe3 / 255, 0xdc / 255), 1);

    this.flow = new Flowmap(this.renderer);
    this.films = [];
    this.time = 0;
    this.scrollY = window.scrollY;
    this.lastScrollY = this.scrollY;

    // pointer state, in screen uv (y up)
    this.pointer = new THREE.Vector2(0.5, 0.5);
    this.pointerSmooth = new THREE.Vector2(0.5, 0.5);
    this.pointerPrev = new THREE.Vector2(0.5, 0.5);
    this.velocity = new THREE.Vector2();
    this.hasPointer = false;

    this.ghost = { x: 0.7, y: 0.6, amount: 0 };
    this.dark = 0; // wall material: 0 plaster → 1 dark stone
    this.darkTarget = 0;
    // swellings live in wall pixels so they scroll with the wall
    this.swells = Array.from({ length: SWELL_COUNT }, () => ({ x: 0, y: 0, amount: 0, radius: 0.2 }));
    this.reveal = { value: 0 };

    this.filmScene = new THREE.Scene();
    this.filmCamera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);

    this._onPointer = this._onPointer.bind(this);
    window.addEventListener("pointermove", this._onPointer, { passive: true });
    window.addEventListener("pointerdown", this._onPointer, { passive: true });

    this.resize();
  }

  // Bake the procedural relief into float textures: a lightly blurred height
  // map and a heavily blurred copy used for cavity shading.
  bakeRelief() {
    const r = this.renderer;
    const src = new THREE.CanvasTexture(createHeightCanvas(HEIGHT_SIZE));
    src.colorSpace = THREE.NoColorSpace;
    src.wrapS = src.wrapT = THREE.RepeatWrapping;
    src.minFilter = THREE.LinearFilter;
    src.generateMipmaps = false;

    const blur = pass(blurFrag, {
      tMap: { value: null },
      uStep: { value: new THREE.Vector2() },
      uSigma: { value: 1 },
    });
    const cam = new THREE.Camera();
    const run = (input, output, stepX, stepY, sigma) => {
      blur.material.uniforms.tMap.value = input;
      blur.material.uniforms.uStep.value.set(stepX, stepY);
      blur.material.uniforms.uSigma.value = sigma;
      r.setRenderTarget(output);
      r.render(blur.scene, cam);
    };
    const wrap = (rt) => {
      rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
      return rt;
    };

    const tmp = wrap(target(HEIGHT_SIZE));
    const height = wrap(target(HEIGHT_SIZE));
    run(src, tmp, 1 / HEIGHT_SIZE, 0, 1.8);
    run(tmp.texture, height, 0, 1 / HEIGHT_SIZE, 1.8);

    const small = 512;
    const tmp2 = wrap(target(small));
    const cavity = wrap(target(small));
    run(height.texture, tmp2, 1 / small, 0, 5);
    run(tmp2.texture, cavity, 0, 1 / small, 5);

    // Bake slopes + self-shadowing into one texture, and grain next to the
    // cavity, so the per-frame shader needs only a few texture reads.
    const DEPTH = 16;
    const bake = pass(reliefBakeFrag, {
      tHeight: { value: height.texture },
      uTexel: { value: new THREE.Vector2(1 / HEIGHT_SIZE, 1 / HEIGHT_SIZE) },
      uDepth: { value: DEPTH },
      uFlat: { value: FLAT },
    });
    const relief = tmp; // reuse the blur scratch target
    r.setRenderTarget(relief);
    r.render(bake.scene, cam);
    const grain = pass(grainBakeFrag, {});
    const grainRT = wrap(target(1024));
    r.setRenderTarget(grainRT);
    r.render(grain.scene, cam);
    r.setRenderTarget(null);

    src.dispose();
    height.dispose();
    tmp2.dispose();
    blur.material.dispose();
    bake.material.dispose();
    grain.material.dispose();

    this.reliefUniforms = {
      tRelief: { value: relief.texture },
      tCavity: { value: cavity.texture },
      tGrain: { value: grainRT.texture },
      tFlow: { value: this.flow.texture },
      uAspect: { value: 1 },
      uScroll: { value: 0 },
      uTime: { value: 0 },
      uRest: { value: this.reducedMotion ? 0.45 : 0.03 },
      uReveal: { value: 0 },
      uDepth: { value: DEPTH },
      uFlat: { value: FLAT },
      // raw sRGB values: THREE.Color would convert hex to linear and darken it
      uColor: { value: new THREE.Vector3(0xe7 / 255, 0xe3 / 255, 0xdc / 255) },
      // matches the navy-black of the film backdrops
      uDarkColor: { value: new THREE.Vector3(0x0b / 255, 0x0d / 255, 0x13 / 255) },
      uDark: { value: 0 },
    };
    this.relief = pass(reliefFrag, this.reliefUniforms);
    this.reliefCamera = new THREE.Camera();
    this.resize();
  }

  // Draw a <video> inside the bounds of a DOM element.
  addFilm(element, video) {
    // Must be a VideoTexture: a plain Texture would allocate storage from
    // video.width (0) instead of videoWidth and render black.
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const uniforms = {
      tVideo: { value: texture },
      tFlow: { value: this.flow.texture },
      uResolution: { value: this._buffer.clone() },
      uPlane: { value: new THREE.Vector2(1, 1) },
      uVideo: { value: new THREE.Vector2(1920, 1080) },
      uTime: { value: 0 },
      uProgress: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: videoVert,
      fragmentShader: videoFrag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(quad, material);
    mesh.frustumCulled = false;
    this.filmScene.add(mesh);

    const film = { element, video, texture, uniforms, mesh, dirty: true };
    const markDirty = () => (film.dirty = true);
    video.addEventListener("seeked", markDirty);
    video.addEventListener("loadeddata", () => {
      uniforms.uVideo.value.set(video.videoWidth || 1920, video.videoHeight || 1080);
      markDirty();
    });
    this.films.push(film);
    return film;
  }

  _onPointer(e) {
    this.pointer.set(e.clientX / this.width, 1 - e.clientY / this.height);
    if (!this.hasPointer) {
      this.pointerSmooth.copy(this.pointer);
      this.pointerPrev.copy(this.pointer);
      this.hasPointer = true;
    }
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    // the wall is soft and the films are 1080p, so extra pixels buy little
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(this.width, this.height, false);
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());

    this.flow.uniforms.uAspect.value = this.width / this.height;
    if (this.reliefUniforms) this.reliefUniforms.uAspect.value = this.height / this.width;

    const cam = this.filmCamera;
    cam.left = 0;
    cam.right = this.width;
    cam.top = 0;
    cam.bottom = -this.height;
    cam.updateProjectionMatrix();
    for (const f of this.films) f.uniforms.uResolution.value.copy(buffer);
    this._buffer = buffer;
  }

  setScroll(y) {
    this.scrollY = y;
  }

  // Ghost cursor: drifts along random arcs so the wall breathes when idle.
  startGhost(gsap) {
    if (this.reducedMotion) return;
    const loop = () => {
      const from = { x: Math.random() * 0.8 + 0.1, y: Math.random() * 0.8 + 0.1 };
      const angle = Math.random() * Math.PI * 2;
      const dist = 0.25 + Math.random() * 0.3;
      const to = {
        x: Math.min(0.95, Math.max(0.05, from.x + Math.cos(angle) * dist)),
        y: Math.min(0.95, Math.max(0.05, from.y + Math.sin(angle) * dist)),
      };
      const ctrl = { x: (from.x + to.x) / 2 + (Math.random() - 0.5) * 0.4, y: (from.y + to.y) / 2 + (Math.random() - 0.5) * 0.4 };
      const state = { t: 0 };
      gsap.to(state, {
        t: 1,
        duration: 2.6 + Math.random() * 1.6,
        ease: "sine.inOut",
        onUpdate: () => {
          const t = state.t;
          const u = 1 - t;
          this.ghost.x = u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x;
          this.ghost.y = u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y;
          this.ghost.amount = Math.sin(Math.PI * t);
        },
        onComplete: () => {
          this.ghost.amount = 0;
          gsap.delayedCall(0.4 + Math.random() * 1.6, loop);
        },
      });
    };
    loop();
  }

  // Random swellings: each slot repeatedly picks a spot on screen, swells it
  // out of the wall and lets it sink back, independent of the cursor.
  startSwells(gsap) {
    if (this.reducedMotion) return;
    this.swells.forEach((swell, i) => {
      const loop = () => {
        swell.x = 0.06 + Math.random() * 0.88;
        swell.y = (0.08 + Math.random() * 0.84) * this.height + this.scrollY * WALL_SPEED;
        swell.radius = 0.12 + Math.random() * 0.16;
        const peak = 0.7 + Math.random() * 0.5;
        gsap.fromTo(
          swell,
          { amount: 0 },
          {
            amount: peak,
            duration: 1.6 + Math.random() * 1.6,
            ease: "sine.inOut",
            yoyo: true,
            repeat: 1,
            repeatDelay: 0.2 + Math.random() * 1.2,
            onComplete: () => gsap.delayedCall(0.5 + Math.random() * 3, loop),
          }
        );
      };
      gsap.delayedCall(0.8 + i * 0.9 + Math.random() * 1.2, loop);
    });
  }

  // Intro: the wall surfaces, then a sweep raises the wreath behind the title.
  intro(gsap) {
    const tl = gsap.timeline();
    tl.to(this.reveal, { value: 1, duration: 1.6, ease: "sine.out" }, 0);
    if (!this.reducedMotion) {
      const s = { t: 0 };
      tl.to(
        s,
        {
          t: 1,
          duration: 2.2,
          ease: "power2.inOut",
          onUpdate: () => {
            const a = s.t * Math.PI * 1.6 - 0.6;
            this.ghost.x = 0.72 + Math.cos(a) * 0.16;
            this.ghost.y = 0.55 + Math.sin(a) * 0.22;
            this.ghost.amount = 1.6 * Math.sin(Math.PI * s.t);
          },
          onComplete: () => {
            this.startGhost(gsap);
            this.startSwells(gsap);
          },
        },
        0.2
      );
    }
    return tl;
  }

  render(deltaMs) {
    if (!this.relief) return;
    const dt = Math.min(deltaMs, 64) / 16.667;
    this.time += deltaMs / 1000;

    // pointer easing + velocity
    const ease = 1 - Math.pow(1 - 0.35, dt);
    this.pointerSmooth.lerp(this.pointer, ease);
    const v = this.pointerSmooth.clone().sub(this.pointerPrev).multiplyScalar(36 / dt);
    v.x *= this.width / this.height;
    this.velocity.lerp(v, v.lengthSq() > this.velocity.lengthSq() ? 0.5 : 0.08);
    this.pointerPrev.copy(this.pointerSmooth);

    // scroll → wall offset, and shift the flow so trails stay on the wall
    const scrollDelta = this.scrollY - this.lastScrollY;
    this.lastScrollY = this.scrollY;

    const fu = this.flow.uniforms;
    fu.uMouse.value.copy(this.hasPointer ? this.pointerSmooth : new THREE.Vector2(-1, -1));
    fu.uVelocity.value.copy(this.velocity);
    fu.uGhost.value.set(this.ghost.x, this.ghost.y);
    fu.uGhostAmount.value = this.ghost.amount;
    fu.uDelta.value = dt;
    fu.uShift.value = (scrollDelta * WALL_SPEED) / this.height;
    fu.uTime.value = this.time;
    const wallOffset = this.scrollY * WALL_SPEED;
    this.swells.forEach((s, i) => {
      fu.uSwells.value[i].set(s.x, 1 - (s.y - wallOffset) / this.height, s.amount, s.radius);
    });
    this.flow.update();

    const ru = this.reliefUniforms;
    ru.tFlow.value = this.flow.texture;
    ru.uScroll.value = (this.scrollY * WALL_SPEED) / this.width;
    ru.uTime.value = this.time;
    ru.uReveal.value = this.reveal.value;
    this.dark += (this.darkTarget - this.dark) * (1 - Math.pow(1 - 0.12, dt));
    ru.uDark.value = this.dark;

    // position video planes; skip the wall if a film covers the screen
    let covered = false;
    for (const f of this.films) {
      const r = f.element.getBoundingClientRect();
      const visible = r.bottom > 0 && r.top < this.height && r.width > 0;
      f.mesh.visible = visible;
      if (!visible) continue;
      if (r.top <= 0.5 && r.left <= 0.5 && r.bottom >= this.height - 0.5 && r.right >= this.width - 0.5) covered = true;
      f.mesh.position.set(r.left + r.width / 2, -(r.top + r.height / 2), 0);
      f.mesh.scale.set(r.width, r.height, 1);
      f.uniforms.uPlane.value.set(r.width, r.height);
      f.uniforms.tFlow.value = this.flow.texture;
      f.uniforms.uTime.value = this.time;
      if (f.video.readyState >= 2 && (f.dirty || !f.video.paused)) {
        f.texture.needsUpdate = true;
        f.dirty = false;
      }
    }

    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear();
    if (!covered) r.render(this.relief.scene, this.reliefCamera);
    r.render(this.filmScene, this.filmCamera);
  }
}
