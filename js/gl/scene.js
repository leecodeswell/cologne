import * as THREE from "three";
import { createCarveCanvas, FLAT, CARVE_DEPTH } from "./heightmap.js";
import { buildSculpture } from "./sculpture.js";
import {
  fullscreenVert,
  flowFrag,
  blurFrag,
  sculptVert,
  sculptFrag,
  combineFrag,
  reliefBakeFrag,
  horizonFrag,
  shadeBakeFrag,
  grainBakeFrag,
  crumpleBakeFrag,
  reliefFrag,
  videoVert,
  videoFrag,
} from "./shaders.js";

const WALL_SPEED = 0.45; // wall parallax relative to page scroll
const MIN_TILE = 760; // css px: on narrower screens the tile overflows to the left
const FLOW_SIZE = 256;
const SWELL_COUNT = 2; // small random swellings alive at once

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

// Build the sculpture in a module worker; fall back to the main thread.
function buildSculptureAsync(opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sculpture.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => (worker.terminate(), resolve(e.data));
    worker.onerror = (e) => (worker.terminate(), reject(e));
    worker.postMessage(opts);
  }).catch(() => buildSculpture(opts));
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
      // immersive-g.com's flowmap: radius 0.38 / 2, 4.7% fade per 60 fps frame
      uFalloff: { value: 0.19 },
      uDissipation: { value: 0.953 },
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
    this.renderer.setClearColor(new THREE.Color().setRGB(0xe0 / 255, 0xe0 / 255, 0xe0 / 255), 1);

    // Bake budget: phones, small screens and weak machines get a 1024 bake
    // with lighter tessellation; float height maps where filterable.
    const ext = this.renderer.extensions;
    this.floatOK = ext.has("EXT_color_buffer_float") && ext.has("OES_texture_float_linear");
    const small = Math.min(screen.width || innerWidth, screen.height || innerHeight) < 600 || matchMedia("(pointer: coarse)").matches;
    const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
    const lowTier = small || weak || this.renderer.capabilities.maxTextureSize < 4096;
    this.bakeSize = lowTier ? 1024 : 2048;
    this.bakeDetail = lowTier ? 0.7 : 1;

    // start building the sculpture now; it is baked once fonts and videos load
    this.sculpture = buildSculptureAsync({ detail: this.bakeDetail });

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
  // Bake the relief (see README, "How the relief is made"):
  //   1. build the sculpture as 3D geometry and render it top-down into a
  //      height map, three copies stacked so the tile wraps vertically;
  //   2. add the carved lettering, blur lightly;
  //   3. bake slopes + curvature, 8-direction horizons, and a soft shadow
  //      toward the light, so the per-frame shader lights any lift level.
  // The geometry is built in a worker started by the constructor, so only
  // the GPU passes run here.
  async bakeRelief() {
    const r = this.renderer;
    const N = this.bakeSize;
    const half = N / 2;
    const t0 = performance.now();

    const data = await this.sculpture;
    const t1 = performance.now();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.position, 3));
    geometry.setAttribute("aMotif", new THREE.BufferAttribute(data.motif, 2));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));

    const wrap = (rt, clampX = false) => {
      rt.texture.wrapS = clampX ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      rt.texture.wrapT = THREE.RepeatWrapping;
      return rt;
    };
    const cam = new THREE.Camera();
    const run = (p, output) => {
      r.setRenderTarget(output);
      r.render(p.scene, cam);
    };

    // 1. sculpture → height, phase, sway (MSAA smooths the silhouettes)
    const sculptRT = target(N, { depthBuffer: true, samples: r.capabilities.isWebGL2 ? 4 : 0 });
    const material = new THREE.ShaderMaterial({ vertexShader: sculptVert, fragmentShader: sculptFrag, side: THREE.DoubleSide });
    const sculpt = new THREE.Scene();
    for (const dy of [-1, 0, 1]) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = dy;
      mesh.frustumCulled = false;
      sculpt.add(mesh);
    }
    const top = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 10);
    top.position.z = 5;
    const clear = r.getClearColor(new THREE.Color());
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(sculptRT);
    r.clear();
    r.render(sculpt, top);
    r.setClearColor(clear, clearAlpha);

    // 2. + lettering, then a light blur (float where the GPU allows it)
    const carve = new THREE.CanvasTexture(createCarveCanvas(N));
    carve.colorSpace = THREE.NoColorSpace;
    carve.minFilter = THREE.LinearFilter;
    carve.generateMipmaps = false;
    const hiType = this.floatOK ? THREE.FloatType : THREE.HalfFloatType;
    const heightA = wrap(target(N, { type: hiType }), true);
    const heightB = wrap(target(N, { type: hiType }), true);
    const combine = pass(combineFrag, {
      tSculpt: { value: sculptRT.texture },
      tCarve: { value: carve },
      uFlat: { value: FLAT },
      uCarve: { value: CARVE_DEPTH },
    });
    run(combine, heightA);

    const blur = pass(blurFrag, { tMap: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: 1 } });
    const blurRun = (input, output, sx, sy, sigma) => {
      blur.material.uniforms.tMap.value = input;
      blur.material.uniforms.uStep.value.set(sx, sy);
      blur.material.uniforms.uSigma.value = sigma;
      run(blur, output);
    };
    const sigma = N >= 2048 ? 1.6 : 1.0; // rounded edges, like embossed paper rather than cut plastic
    blurRun(heightA.texture, heightB, 1 / N, 0, sigma);
    blurRun(heightB.texture, heightA, 0, 1 / N, sigma);
    const height = heightA.texture;

    // 3a. slopes + curvature
    const relief = wrap(target(N), true);
    const reliefBake = pass(reliefBakeFrag, { tHeight: { value: height }, uTexel: { value: new THREE.Vector2(1 / N, 1 / N) } });
    run(reliefBake, relief);

    // 3b. 8-direction horizons for ambient occlusion
    const horizonA = wrap(target(half), true);
    const horizonB = wrap(target(half), true);
    const horizon = pass(horizonFrag, { tHeight: { value: height }, uDir0: { value: 0 }, uRadius: { value: 0.022 } });
    run(horizon, horizonA);
    horizon.material.uniforms.uDir0.value = 4;
    run(horizon, horizonB);

    // 3c. cavity (wide blur) + soft shadow + phase/sway
    const small = 512;
    const cavA = wrap(target(small), true);
    const cavB = wrap(target(small), true);
    blurRun(height, cavA, 1 / small, 0, 5);
    blurRun(cavA.texture, cavB, 0, 1 / small, 5);
    const shadeRT = wrap(target(half), true);
    const shade = pass(shadeBakeFrag, { tHeight: { value: height }, tCavity: { value: cavB.texture } });
    run(shade, shadeRT);

    const grain = pass(grainBakeFrag, {});
    const grainRT = wrap(target(1024));
    run(grain, grainRT);

    // crumpled-paper facets, softened so the creases read as folds in paper
    const crumple = pass(crumpleBakeFrag, {});
    const crumpleRT = wrap(target(1024));
    const crumpleTmp = wrap(target(1024));
    run(crumple, crumpleRT);
    blurRun(crumpleRT.texture, crumpleTmp, 1 / 1024, 0, 2.2);
    blurRun(crumpleTmp.texture, crumpleRT, 0, 1 / 1024, 2.2);
    crumpleTmp.dispose();
    r.setRenderTarget(null);

    for (const d of [geometry, material, carve, sculptRT, heightA, heightB, cavA, cavB]) d.dispose();
    for (const p of [combine, blur, reliefBake, horizon, shade, grain, crumple]) p.material.dispose();
    this.bakeStats = { size: N, vertices: geometry.attributes.position.count, waitMs: Math.round(t1 - t0), totalMs: Math.round(performance.now() - t0) };

    this.reliefUniforms = {
      tRelief: { value: relief.texture },
      tHorizonA: { value: horizonA.texture },
      tHorizonB: { value: horizonB.texture },
      tShade: { value: shadeRT.texture },
      tGrain: { value: grainRT.texture },
      tCrumple: { value: crumpleRT.texture },
      tFlow: { value: this.flow.texture },
      uFlowTexel: { value: new THREE.Vector2(1 / FLOW_SIZE, 1 / FLOW_SIZE) },
      uBulge: { value: this.reducedMotion ? 0 : 0.005 },
      // camera distance for the perspective push-out (immersive-g's sits
      // ~0.85 tile widths back; ours is a little further, our relief is deeper)
      uPersp: { value: 1.6 },
      uCrumple: { value: this.reducedMotion ? 0 : 0.16 },
      uSnap: { value: this.reducedMotion ? 0 : 0.55 },
      uSmear: { value: this.reducedMotion ? 0 : 0.035 },
      uAspect: { value: 1 },
      uTileScale: { value: 1 },
      uTileX: { value: 0 },
      uScroll: { value: 0 },
      uTime: { value: 0 },
      // blank plaster at rest, as on immersive-g.com; ?relief=full in the URL
      // holds the whole relief raised, for reviewing the design
      uRest: { value: new URLSearchParams(location.search).get("relief") === "full" ? 1 : this.reducedMotion ? 0.4 : 0.0 },
      uReveal: { value: 0 },
      uDepth: { value: 0.5 }, // gentle slopes: forms swell softly instead of turning dark sides
      uAO: { value: 0.25 },
      uAlive: { value: this.reducedMotion ? 0 : 0.12 },
      // raw sRGB values: THREE.Color would convert hex to linear and darken it
      // immersive-g.com's wall: neutral grey, about #e0e0e0 at rest
      uColor: { value: new THREE.Vector3(0xe0 / 255, 0xe0 / 255, 0xe0 / 255) },
      // matches the navy-black of the film backdrops
      uDarkColor: { value: new THREE.Vector3(0x0b / 255, 0x0d / 255, 0x13 / 255) },
      uDark: { value: 0 },
    };
    this.relief = pass(reliefFrag, this.reliefUniforms);
    this.reliefCamera = new THREE.Camera();
    this.resize();
  }

  // Draw a <video> inside the bounds of a DOM element.
  // With a WebCodecs frame source (framesource.js) the texture comes from its
  // canvas, which works even where the browser stops presenting frames for
  // an invisible <video>; otherwise the <video> itself is the texture.
  addFilm(element, video, source = null) {
    // Must be a VideoTexture for <video>: a plain Texture would allocate
    // storage from video.width (0) instead of videoWidth and render black.
    const texture = source ? new THREE.CanvasTexture(source.canvas) : new THREE.VideoTexture(video);
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

    const film = { element, video, source, texture, uniforms, mesh, dirty: true };
    const markDirty = () => (film.dirty = true);
    if (source) {
      uniforms.uVideo.value.set(source.width, source.height);
      source.onFrame = markDirty;
    } else {
      video.addEventListener("seeked", markDirty);
      video.addEventListener("loadeddata", () => {
        uniforms.uVideo.value.set(video.videoWidth || 1920, video.videoHeight || 1080);
        markDirty();
      });
    }
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
    this.width = document.documentElement.clientWidth; // excludes the scrollbar
    this.height = window.innerHeight;
    // the wall is soft and the films are 1080p, so extra pixels buy little
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(this.width, this.height, false);
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());

    this.flow.uniforms.uAspect.value = this.width / this.height;
    // the tile is at least MIN_TILE wide; on phones the viewport shows its
    // right-hand part, where the wreath and medallion sit
    this.tilePx = Math.max(this.width, MIN_TILE);
    if (this.reliefUniforms) {
      const scale = this.width / this.tilePx;
      this.reliefUniforms.uAspect.value = this.height / this.width;
      this.reliefUniforms.uTileScale.value = scale;
      this.reliefUniforms.uTileX.value = Math.max(0, 0.97 - scale);
    }

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

  // Random swellings: now and then a small patch of the wall swells up on its
  // own and sinks back, so the wall feels alive between cursor movements.
  // The relief is otherwise revealed only by the cursor.
  startSwells(gsap) {
    if (this.reducedMotion) return;
    this.swells.forEach((swell, i) => {
      const loop = () => {
        swell.x = 0.08 + Math.random() * 0.84;
        swell.y = (0.1 + Math.random() * 0.8) * this.height + this.scrollY * WALL_SPEED;
        swell.radius = 0.05 + Math.random() * 0.045;
        const peak = 0.55 + Math.random() * 0.35;
        gsap.fromTo(
          swell,
          { amount: 0 },
          {
            amount: peak,
            duration: 1.4 + Math.random() * 1.0,
            ease: "sine.inOut",
            yoyo: true,
            repeat: 1,
            repeatDelay: 0.3 + Math.random() * 0.6,
            onComplete: () => gsap.delayedCall(3 + Math.random() * 5, loop),
          }
        );
      };
      gsap.delayedCall(2 + i * 2.5 + Math.random() * 2, loop);
    });
  }

  // Intro: the wall surfaces as blank plaster; after that the relief appears
  // only under the cursor and in the occasional small swelling.
  intro(gsap) {
    const tl = gsap.timeline();
    tl.to(this.reveal, { value: 1, duration: 1.6, ease: "sine.out" }, 0);
    if (!this.reducedMotion) {
      tl.add(() => this.startSwells(gsap), 1.2);
    }
    return tl;
  }

  render(deltaMs) {
    if (!this.relief) return;
    const dt = Math.min(deltaMs, 64) / 16.667;
    this.time += deltaMs / 1000;

    // pointer easing + velocity, with immersive-g.com's rates: the cursor
    // eases at 0.4, velocity builds at 0.1 while moving and bleeds off at 0.04
    const ease = 1 - Math.pow(1 - 0.4, dt);
    this.pointerSmooth.lerp(this.pointer, ease);
    const v = this.pointerSmooth.clone().sub(this.pointerPrev).multiplyScalar(36 / dt);
    v.x *= this.width / this.height;
    const rate = v.lengthSq() > 1e-6 ? 0.1 : 0.04;
    this.velocity.lerp(v, 1 - Math.pow(1 - rate, dt));
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
    ru.uScroll.value = (this.scrollY * WALL_SPEED) / this.tilePx;
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
      if (f.source) {
        if (f.dirty) {
          f.texture.needsUpdate = true;
          f.dirty = false;
        }
      } else if (f.video.readyState >= 2 && (f.dirty || !f.video.paused)) {
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
