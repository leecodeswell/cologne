// GLSL for the wall. All passes draw a full-screen quad whose vertex shader
// writes clip space directly, so no camera matrices are involved.

export const fullscreenVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`;

// --------------------------------------------------------------------------
// Flowmap: a small ping-pong buffer the cursor paints into.
//   rg = cursor velocity, b = cursor "lift", a = ghost-cursor lift.
// Everything decays each frame, so the relief sinks back after you pass.
// --------------------------------------------------------------------------
export const flowFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tPrev;
  uniform vec2 uMouse;
  uniform vec2 uVelocity;
  uniform vec2 uGhost;
  uniform float uGhostAmount;
  uniform float uAspect;      // width / height
  uniform float uFalloff;
  uniform float uDissipation; // per 60 fps frame
  uniform float uDelta;       // frame time / 16.6 ms
  uniform float uShift;       // scroll since last frame, in screen uv
  uniform float uTime;
  // random swellings that rise and fall in place: xy = centre, z = amount, w = radius
  uniform vec4 uSwells[SWELL_COUNT];
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  float stamp(vec2 uv, vec2 center, float falloff) {
    vec2 d = uv - center;
    d.x *= uAspect;
    return smoothstep(falloff, 0.0, length(d));
  }

  // same, with the rim pushed in and out by drifting noise so swellings
  // grow like spreading damp in plaster rather than as circles
  float bloom(vec2 uv, vec2 center, float falloff, float seed) {
    vec2 d = uv - center;
    d.x *= uAspect;
    vec2 q = d / falloff * 2.2 + seed;
    float warp = noise(q + uTime * 0.06) * 0.65 + noise(q * 2.3 - uTime * 0.04) * 0.35 - 0.5;
    return smoothstep(falloff, 0.0, length(d) + warp * falloff * 0.55);
  }

  void main() {
    // follow the wall as it scrolls
    vec2 uv = vUv - vec2(0.0, uShift);
    vec4 data = texture2D(tPrev, uv);
    if (uv.y < 0.0 || uv.y > 1.0) data = vec4(0.0);
    data *= pow(uDissipation, uDelta);

    // coarse, slowly drifting mask: the trail reveals fully in some patches
    // and barely in others, which is what makes immersive-g's wall look like
    // paper catching rather than a soft brush
    vec2 nuv = vUv * vec2(uAspect, 1.0);
    float coarse = noise(nuv * 3.2 + uTime * 0.05) * 0.7 + noise(nuv * 7.0 - uTime * 0.03) * 0.3;
    float n1 = 0.15 + 0.85 * smoothstep(0.35, 0.85, coarse);
    float n2 = smoothstep(0.3, 0.95, noise(nuv * 3.0 - uTime * 0.08));

    // stamp at full strength each frame (saturates almost at once, then
    // decays): a quick, decisive pop instead of a slow fade-in
    float speed = length(uVelocity);
    float lift = 1.0 - pow(1.0 - min(1.0, speed * 1.4), 2.0);
    float f = stamp(vUv, uMouse, uFalloff);
    data.rg += uVelocity * f * uDelta;
    data.b += lift * f * n1 * uDelta;

    float g = bloom(vUv, uGhost, uFalloff * 1.25, 3.1);
    data.a += uGhostAmount * g * n2 * uDelta * 0.05;

    for (int i = 0; i < SWELL_COUNT; i++) {
      vec4 sw = uSwells[i];
      if (sw.z <= 0.0) continue;
      float n3 = 0.35 + 0.65 * smoothstep(0.2, 0.9, noise(nuv * 4.0 + float(i) * 7.3 + uTime * 0.05));
      data.a += sw.z * bloom(vUv, sw.xy, sw.w, float(i) * 5.7) * n3 * uDelta * 0.06;
    }

    data = clamp(data, vec4(-1.0, -1.0, 0.0, 0.0), vec4(1.0));
    gl_FragColor = data;
  }
`;

// --------------------------------------------------------------------------
// Separable gaussian blur, used once to bake the height map on the GPU.
// --------------------------------------------------------------------------
export const blurFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tMap;
  uniform vec2 uStep;
  uniform float uSigma;
  varying vec2 vUv;
  void main() {
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int i = -12; i <= 12; i++) {
      float x = float(i);
      float w = exp(-x * x / (2.0 * uSigma * uSigma));
      acc += texture2D(tMap, vUv + uStep * x) * w;
      wsum += w;
    }
    gl_FragColor = acc / wsum;
  }
`;
// --------------------------------------------------------------------------
// Bake pass 1: the sculpture (sculpture.js), rendered once from straight
// above with an orthographic camera. The depth test keeps the highest
// surface, so overhanging petals hide what lies beneath them.
//   r = height in tile widths, g = motif phase, b = sway weight
// --------------------------------------------------------------------------
export const sculptVert = /* glsl */ `
  attribute vec2 aMotif;
  varying vec3 vData;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vData = vec3(world.z, aMotif);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const sculptFrag = /* glsl */ `
  precision highp float;
  varying vec3 vData;
  void main() {
    gl_FragColor = vec4(vData, 1.0);
  }
`;

// Bake pass 2: add the carved lettering (an 8-bit canvas) to the sculpture.
export const combineFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tSculpt;
  uniform sampler2D tCarve;
  uniform float uFlat;
  uniform float uCarve;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(tSculpt, vUv);
    float c = texture2D(tCarve, vUv).r;
    gl_FragColor = vec4(s.r + (c - uFlat) * uCarve, s.g, s.b, 1.0);
  }
`;

const LIGHT_GLSL = `const vec3 LIGHT = vec3(-0.52, 0.62, 0.58);`;

const HASH_GLSL = `float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`;

// --------------------------------------------------------------------------
// Bake pass 3: slopes and curvature at full resolution.
//   r = height, g/b = slope along u/v, a = curvature (Laplacian / 1000)
// --------------------------------------------------------------------------
export const reliefBakeFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tHeight;
  uniform vec2 uTexel;
  varying vec2 vUv;

  float H(vec2 p) { return texture2D(tHeight, p).r; }

  void main() {
    vec2 e = uTexel;
    float h0 = H(vUv);
    float sx = (H(vUv + vec2(e.x, 0.0)) - H(vUv - vec2(e.x, 0.0))) / (2.0 * e.x);
    float sy = (H(vUv + vec2(0.0, e.y)) - H(vUv - vec2(0.0, e.y))) / (2.0 * e.y);
    vec2 f = e * 2.0;
    float lap = H(vUv + vec2(f.x, 0.0)) + H(vUv - vec2(f.x, 0.0))
              + H(vUv + vec2(0.0, f.y)) + H(vUv - vec2(0.0, f.y)) - 4.0 * h0;
    lap /= f.x * f.x;
    gl_FragColor = vec4(h0, sx, sy, clamp(lap * 1e-3, -60.0, 60.0));
  }
`;

// --------------------------------------------------------------------------
// Bake pass 4: horizon slopes in 8 directions (two passes of 4 channels).
// For each direction, the steepest rise of the relief seen from this pixel,
// with far terrain weighted down. A relief extruded by k has exactly k times
// these slopes, so the wall shader derives ambient occlusion for any lift
// from them: Immersive Garden's multi-level lighting bake, made continuous.
// --------------------------------------------------------------------------
export const horizonFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tHeight;
  uniform float uDir0;    // first of the four directions (0 or 4)
  uniform float uRadius;  // falloff distance, tile widths
  varying vec2 vUv;
  ${HASH_GLSL}

  float H(vec2 p) { return texture2D(tHeight, p).r; }

  void main() {
    float h0 = H(vUv);
    float jitter = hash(gl_FragCoord.xy);
    vec4 m = vec4(0.0);
    for (int d = 0; d < 4; d++) {
      float a = (float(d) + uDir0 + jitter * 0.5) * 0.7854;
      vec2 dir = vec2(cos(a), sin(a));
      float best = 0.0;
      float dist = 0.0005 * (1.0 + jitter);
      for (int i = 0; i < 14; i++) {
        float s = (H(vUv + dir * dist) - h0) / dist;
        float w = 1.0 / (1.0 + dist * dist / (uRadius * uRadius));
        best = max(best, s * w);
        dist *= 1.4;
      }
      m[d] = best;
    }
    gl_FragColor = m;
  }
`;

// --------------------------------------------------------------------------
// Bake pass 5: soft shadow toward the light plus the slow channels.
//   r = steepest rise toward the light (averaged over a small area light),
//   g = wide-blurred height (cavity), b = motif phase, a = sway weight
// --------------------------------------------------------------------------
export const shadeBakeFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tHeight;
  uniform sampler2D tCavity;
  varying vec2 vUv;
  ${LIGHT_GLSL}
  ${HASH_GLSL}

  float H(vec2 p) { return texture2D(tHeight, p).r; }

  void main() {
    vec4 c = texture2D(tHeight, vUv);
    float h0 = c.r;
    float jitter = hash(gl_FragCoord.xy);
    float base = atan(LIGHT.y, LIGHT.x);
    float sum = 0.0;
    for (int k = -1; k <= 1; k++) {
      float a = base + float(k) * 0.14;
      vec2 dir = vec2(cos(a), sin(a));
      float best = 0.0;
      float dist = 0.0006 * (1.0 + jitter * 0.6);
      for (int i = 0; i < 16; i++) {
        best = max(best, (H(vUv + dir * dist) - h0) / dist);
        dist *= 1.3;
      }
      sum += best;
    }
    gl_FragColor = vec4(sum / 3.0, texture2D(tCavity, vUv).r, c.g, c.b);
  }
`;

// One-time bake: plaster grain (fbm) that tiles exactly once per wall tile,
// like the relief, so its repeat never shows as a seam on screen.
export const grainBakeFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  // value noise that repeats every 'period' cells, so the texture tiles
  float noise(vec2 p, float period) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 i1 = mod(i + 1.0, period);
    i = mod(i, period);
    return mix(mix(hash(i), hash(vec2(i1.x, i.y)), u.x),
               mix(hash(vec2(i.x, i1.y)), hash(i1), u.x), u.y);
  }

  void main() {
    float v = 0.0, a = 0.5, period = 220.0;
    for (int i = 0; i < 2; i++) {
      v += a * noise(vUv * period, period);
      period *= 2.0;
      a *= 0.5;
    }
    // marble veins: thin ridges of a warped low-frequency noise
    vec2 w = vUv + 0.04 * vec2(noise(vUv * 9.0, 9.0), noise(vUv * 9.0 + 3.1, 9.0));
    float r1 = 1.0 - abs(noise(w * 5.0, 5.0) * 2.0 - 1.0);
    float r2 = 1.0 - abs(noise(w * 11.0 + 1.7, 11.0) * 2.0 - 1.0);
    float veins = pow(r1, 60.0) + 0.5 * pow(r2, 80.0);
    gl_FragColor = vec4(v / 0.75, veins, 0.0, 1.0);
  }
`;

// One-time bake: crumpled paper. Two octaves of tileable Voronoi facets,
// each tilted at random, so a bending sheet breaks into flat planes with
// sharp creases instead of a smooth swell.
//   rg = facet tilt, b = cell random (pop order), a = distance to a crease
export const crumpleBakeFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  // nearest jittered cell (wrapping every 'period' cells) and edge distance
  void voronoi(vec2 uv, float period, out vec2 id, out float edge) {
    vec2 g = uv * period;
    vec2 i = floor(g), f = fract(g);
    float d1 = 8.0, d2 = 8.0;
    id = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        vec2 cell = mod(i + o, period);
        vec2 r = o + 0.08 + hash2(cell) * 0.84 - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = cell; }
        else if (d < d2) { d2 = d; }
      }
    }
    edge = sqrt(d2) - sqrt(d1);
  }

  void main() {
    vec2 id1, id2;
    float e1, e2;
    voronoi(vUv, 36.0, id1, e1);
    voronoi(vUv, 89.0, id2, e2);
    vec2 t1 = hash2(id1 + 3.7) * 2.0 - 1.0;
    vec2 t2 = hash2(id2 + 9.1) * 2.0 - 1.0;
    gl_FragColor = vec4(t1 * 0.72 + t2 * 0.28, hash2(id1 + 1.3).x, min(e1, e2 * 1.6));
  }
`;

// --------------------------------------------------------------------------
// The plaster wall. Lit per pixel from the baked relief; the flowmap scales
// the relief depth so motifs rise where the cursor has been. Every lighting
// term (normal, a faint ambient occlusion, rim) is derived for
// the current extrusion, so a half-risen petal is shaded like a shallower
// carving rather than a faded deep one.
// --------------------------------------------------------------------------
export const reliefFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tRelief;   // height, slope u, slope v, curvature
  uniform sampler2D tHorizonA; // horizon slopes, directions 0-3
  uniform sampler2D tHorizonB; // horizon slopes, directions 4-7
  uniform sampler2D tShade;    // light horizon, cavity height, phase, sway
  uniform sampler2D tGrain;    // plaster grain
  uniform sampler2D tCrumple;  // facet tilt, cell random, crease distance
  uniform sampler2D tFlow;
  uniform vec2 uFlowTexel;   // 1 / flowmap size
  uniform float uBulge;      // how far the sheet itself swells under the trail (tile widths)
  uniform float uPersp;      // camera distance in tile widths (perspective push-out)
  uniform float uCrumple;    // facet tilt while the sheet bends
  uniform float uSnap;       // 0 = smooth rise, 1 = rises in five distinct beats
  uniform float uSmear;      // how much the image stretches across a rising/sinking edge
  uniform float uAspect;     // viewport height / width
  uniform float uTileScale;  // viewport width / tile width (<= 1 on phones)
  uniform float uTileX;      // left edge of the viewport on the tile
  uniform float uScroll;     // wall offset in tile units
  uniform float uTime;
  uniform float uRest;       // relief depth with no cursor activity
  uniform float uReveal;     // intro, 0 → 1
  uniform float uDepth;      // slope exaggeration at full lift
  uniform float uAO;         // ambient occlusion strength
  uniform float uAlive;      // amplitude of the per-motif breathing
  uniform vec3 uColor;
  uniform vec3 uDarkColor;
  uniform float uDark;       // 0 = plaster, 1 = dark polished stone
  varying vec2 vUv;
  ${LIGHT_GLSL}
  ${HASH_GLSL}

  void main() {
    // wall coordinates: the tile spans the viewport width (or more on phones)
    float wallY = (1.0 - vUv.y) * uAspect * uTileScale + uScroll;
    vec2 p = vec2(uTileX + vUv.x * uTileScale, 1.0 - wallY);

    // cursor + ghost/swelling lift add up (as on immersive-g.com)
    vec4 flow = texture2D(tFlow, vUv);
    float lift = clamp(flow.b + flow.a, 0.0, 1.0);

    // the sheet itself swells under the trail like paper pushed from behind;
    // its slope (tile units) comes from the flowmap gradient
    vec2 fe = uFlowTexel * 4.0; // wide taps: the sheet bends softly, no hard rim
    float lR = dot(texture2D(tFlow, vUv + vec2(fe.x, 0.0)).ba, vec2(1.0));
    float lL = dot(texture2D(tFlow, vUv - vec2(fe.x, 0.0)).ba, vec2(1.0));
    float lU = dot(texture2D(tFlow, vUv + vec2(0.0, fe.y)).ba, vec2(1.0));
    float lD = dot(texture2D(tFlow, vUv - vec2(0.0, fe.y)).ba, vec2(1.0));
    vec2 gradL = vec2(min(lR, 1.0) - min(lL, 1.0), min(lU, 1.0) - min(lD, 1.0)) / (2.0 * fe);
    vec2 sheet = uBulge * uReveal * gradL / (uTileScale * vec2(1.0, uAspect));
    float sheetH = uBulge * uReveal * lift;

    // The wall and the sculpture behave as one membrane (as on
    // immersive-g.com, where they are one mesh). Where it rises toward the
    // camera, perspective pushes it outward from the screen centre; where
    // neighbouring parts sit at different heights, the image stretches and
    // smears, so motifs melt in and out instead of fading. The warp uses the
    // wide-blurred height, so it bends smoothly rather than tearing.
    vec2 fromCentre = (vUv - 0.5) * vec2(1.0, uAspect) * uTileScale;
    float lk0 = smoothstep(0.0, 1.0, clamp(lift * 1.3, 0.0, 1.0));
    float hSoft = max(texture2D(tShade, p).g, 0.0);
    float hm = hSoft * lk0 * uReveal + sheetH;
    vec2 gradT = gradL / (uTileScale * vec2(1.0, uAspect));
    vec2 warp = fromCentre * hm / uPersp + gradT * hSoft * uSmear * uReveal;
    float wl = length(warp);
    p -= wl > 0.012 ? warp * (0.012 / wl) : warp; // never more than ~1% of the wall

    vec4 relief = texture2D(tRelief, p);
    vec4 shade = texture2D(tShade, p);
    vec4 crum = texture2D(tCrumple, p);
    float phase = shade.b;
    float sway = shade.a;

    // motifs rise in a staggered order (by motif and by paper facet), in five
    // quick beats like a relief baked at five depths, then breathe while raised
    float lk = clamp(lift * 1.35 - phase * 0.3 - crum.b * 0.18, 0.0, 1.0);
    float beats = lk * 5.0;
    float stepped = (floor(beats) + smoothstep(0.0, 0.4, fract(beats))) / 5.0;
    lk = mix(lk, stepped, uSnap);
    lk = lk * lk * (3.0 - 2.0 * lk);
    float breathe = 1.0 + uAlive * sway * lk * sin(uTime * (1.1 + phase * 0.8) + phase * 37.0);
    float k = mix(uRest, 1.0, lk) * uReveal * breathe;
    float s = uDepth * k;

    // crumpled paper: while the sheet bends (mid-rise, or on the swell's
    // flanks) it breaks into tilted flat facets with sharp creases
    // (raised paper keeps a gentle crumple too, so shapes never read as hard plastic)
    float bend = 4.0 * lk * (1.0 - lk) * 0.7 + clamp(length(sheet) * 3.0, 0.0, 0.5) + lk * 0.3;
    vec2 facet = crum.rg * uCrumple * bend * uReveal;
    float crease = (1.0 - smoothstep(0.0, 0.07, crum.a)) * bend;

    // paper fibre: a fine, soft tooth across the whole sheet
    vec2 ge = vec2(1.0 / 1024.0, 0.0);
    vec2 fibre = vec2(texture2D(tGrain, p + ge.xy).r - texture2D(tGrain, p - ge.xy).r,
                      texture2D(tGrain, p + ge.yx).r - texture2D(tGrain, p - ge.yx).r) * 0.05 * uReveal;

    vec3 n = normalize(vec3(-relief.g * s - sheet.x - facet.x - fibre.x, -relief.b * s - sheet.y - facet.y - fibre.y, 1.0));
    vec3 L = normalize(LIGHT);
    float diff = max(dot(n, L), 0.0);

    // ambient occlusion: mean sine of the horizon angle over 8 directions
    vec4 ha = max(texture2D(tHorizonA, p) * s, 0.0);
    vec4 hb = max(texture2D(tHorizonB, p) * s, 0.0);
    vec4 oa = ha * inversesqrt(1.0 + ha * ha);
    vec4 ob = hb * inversesqrt(1.0 + hb * hb);
    float occl = dot(oa + ob, vec4(0.125));
    float ao = clamp(1.0 - uAO * occl, 0.0, 1.0);

    // Plaster: white on white, lit like soft overcast daylight. There is no
    // cast shadow, no cavity or contact darkening and no specular shine; the
    // forms read only through a gentle brightening of slopes that face the
    // light and a faint dimming of those turned away, plus a whisper of
    // ambient occlusion deep inside folds.
    float shadow = 1.0; // (kept for the dark stone below)
    float curv = -relief.a * s;
    vec2 nxy = n.xy + 1e-5;
    float toLight = max(dot(normalize(nxy), normalize(L.xy)), 0.0);
    float rim = smoothstep(0.25, 1.6, curv) * (0.35 + 0.65 * toLight);

    float facingL = dot(n, L) - L.z;              // + toward the light, - away
    float lit = 1.0 + 0.2 * clamp(facingL, -1.0, 1.0);
    lit = mix(1.0, lit, 0.9) * mix(1.0, ao, 0.35);
    vec3 plaster = uColor * lit;
    // faint marble veins in the plaster, as on immersive-g.com
    plaster *= 1.0 - texture2D(tGrain, p).g * 0.014;
    // paper folds catch the faintest line while the sheet is bending
    plaster *= 1.0 - crease * 0.01;
    vec3 R = reflect(-L, n);

    // dark polished stone: little diffuse, glossy highlights catch the edges
    float edge = smoothstep(0.04, 0.4, 1.0 - n.z);
    float gloss = pow(max(R.z, 0.0), 10.0);
    float rimS = smoothstep(0.02, 0.5, 1.0 - n.z) * toLight;
    float facing = max(dot(n, L), 0.0) - L.z; // > 0 on slopes turned to the light
    vec3 stone = uDarkColor * (0.8 + 1.2 * (lit - 1.0)) * mix(1.0, ao * shadow, 0.75);
    stone += vec3(0.24, 0.25, 0.29) * max(facing, 0.0) * k * shadow;
    stone += vec3(0.62, 0.66, 0.72) * (gloss * 0.8 + rimS * 0.35 + rim * 0.5) * k * shadow;

    vec3 col = mix(plaster, stone, uDark);

    // grain, soft light falloff, dithering
    float grain = texture2D(tGrain, p).r;
    // plaster grain is faint (about ±1.5%, like immersive-g's plaster map)
    col *= mix(0.985 + 0.03 * grain, 0.9 + 0.2 * grain, uDark);
    // soft light from the top-left
    float vign = length((vUv - vec2(0.0, 0.8)) * vec2(1.0, uAspect));
    col *= mix(1.02 - 0.045 * vign, 1.12 - 0.35 * vign, uDark);
    col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;

    gl_FragColor = vec4(col, 1.0);
  }
`;


// --------------------------------------------------------------------------
// Video planes, positioned over DOM elements. The same flowmap bends and
// splits the image like light through glass.
// --------------------------------------------------------------------------
export const videoVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// The films also get a "lens" pass: sharpening, highlight bloom with warm
// halation, a filmic curve, edge fringing, a light sweep that follows the
// scroll, and fine grain — so the footage reads as photographed glass.
export const videoFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tVideo;
  uniform sampler2D tFlow;
  uniform vec2 uResolution;  // drawing buffer size
  uniform vec2 uPlane;       // plane size in css px
  uniform vec2 uVideo;       // video size in px
  uniform float uTime;
  uniform float uProgress;   // chapter scroll progress, drives the light sweep
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  vec2 cover(vec2 uv) {
    float pa = uPlane.x / uPlane.y;
    float va = uVideo.x / uVideo.y;
    vec2 s = pa > va ? vec2(1.0, va / pa) : vec2(pa / va, 1.0);
    return (uv - 0.5) * s + 0.5;
  }

  vec3 bright(vec2 uv) {
    vec3 c = texture2D(tVideo, uv).rgb;
    return c * smoothstep(0.55, 0.95, luma(c));
  }

  void main() {
    vec2 texel = 1.0 / uVideo;
    vec2 suv = gl_FragCoord.xy / uResolution;
    vec4 flow = texture2D(tFlow, suv);
    float lift = clamp(flow.b, 0.0, 1.0);
    vec2 off = clamp(flow.rg, -1.0, 1.0) * 0.018 * lift;

    vec2 base = cover(vUv);
    vec2 uv = base - off;
    vec2 q = base - 0.5;

    // refraction from the cursor trail + radial lens fringing toward the edges
    float ca = length(off) * 0.5 + 0.0008 * lift;
    vec2 cdir = normalize(off + 1e-5);
    vec2 lens = q * dot(q, q) * 0.012;
    vec3 col;
    col.r = texture2D(tVideo, uv + cdir * ca + lens).r;
    col.g = texture2D(tVideo, uv).g;
    col.b = texture2D(tVideo, uv - cdir * ca - lens).b;

    // sharpen luma (recovers crispness lost to compression)
    vec2 d = texel * 1.25;
    float blurL = 0.25 * (
      luma(texture2D(tVideo, uv + vec2(d.x, d.y)).rgb) +
      luma(texture2D(tVideo, uv + vec2(-d.x, d.y)).rgb) +
      luma(texture2D(tVideo, uv + vec2(d.x, -d.y)).rgb) +
      luma(texture2D(tVideo, uv + vec2(-d.x, -d.y)).rgb));
    float l = luma(col);
    col += (l - blurL) * 0.65;

    // bloom + halation from a ring of highlight samples
    vec3 bloom = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float a = float(i) * 1.0472 + 0.39;
      bloom += bright(uv + vec2(cos(a), sin(a)) * texel * 11.0);
    }
    col += bloom / 6.0 * vec3(1.0, 0.9, 0.82) * 0.55;

    // filmic curve: gentle S, rolled-off highlights, navy-tinted shadows
    // (clamp first: the cubic folds negative above 1.5 and bands the highlights)
    col = max(col, 0.0);
    vec3 c1 = min(col, 1.0);
    vec3 s = c1 * c1 * (3.0 - 2.0 * c1);
    col = mix(col, s, 0.3);
    col = col / (1.0 + col * 0.12) * 1.1;
    l = luma(col);
    col = mix(col * vec3(0.9, 0.96, 1.1), col, smoothstep(0.0, 0.35, l));

    // a soft band of light glides across the glass as you scroll
    vec2 sweepDir = normalize(vec2(1.0, 0.55));
    float band = dot(vUv - 0.5, sweepDir) - (uProgress * 1.8 - 0.9);
    float sweep = exp(-band * band * 38.0);
    col += sweep * smoothstep(0.18, 0.75, l) * 0.16 * vec3(1.0, 0.98, 0.95);

    // highlight lift along the cursor trail
    col += lift * 0.04 * smoothstep(0.35, 1.0, l);

    // vignette + fine, luminance-weighted grain
    vec2 v = vUv - 0.5;
    col *= 1.0 - dot(v, v) * 0.55;
    float g = hash(gl_FragCoord.xy + fract(uTime * 24.0) * 97.0) - 0.5;
    col += g * mix(0.05, 0.02, l);

    gl_FragColor = vec4(col, 1.0);
  }
`;
