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

    // organic, non-circular edges
    vec2 nuv = vUv * vec2(uAspect, 1.0);
    float n1 = 0.25 + 0.75 * smoothstep(0.25, 0.9, noise(nuv * 5.0 + uTime * 0.12));
    float n2 = smoothstep(0.3, 0.95, noise(nuv * 3.0 - uTime * 0.08));

    float speed = length(uVelocity);
    float lift = 1.0 - pow(1.0 - min(1.0, speed * 1.4), 2.0);
    float f = stamp(vUv, uMouse, uFalloff);
    data.rg += uVelocity * f * uDelta;
    data.b += lift * f * n1 * uDelta * 0.22;

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
    gl_FragColor = vec4(v / 0.75);
  }
`;

// --------------------------------------------------------------------------
// The plaster wall. Lit per pixel from the baked relief; the flowmap scales
// the relief depth so motifs rise where the cursor has been. Every lighting
// term (normal, ambient occlusion, cast shadow, cavity, rim) is derived for
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
  uniform sampler2D tFlow;
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

    vec4 flow = texture2D(tFlow, vUv);
    float lift = clamp(max(flow.b, flow.a), 0.0, 1.0);

    vec4 relief = texture2D(tRelief, p);
    vec4 shade = texture2D(tShade, p);
    float phase = shade.b;
    float sway = shade.a;

    // motifs rise in a staggered order, then breathe while they are raised
    float lk = clamp(lift * 1.3 - phase * 0.3, 0.0, 1.0);
    lk = lk * lk * (3.0 - 2.0 * lk);
    float breathe = 1.0 + uAlive * sway * lk * sin(uTime * (1.1 + phase * 0.8) + phase * 37.0);
    float k = mix(uRest, 1.0, lk) * uReveal * breathe;
    float s = uDepth * k;

    vec3 n = normalize(vec3(-relief.g * s, -relief.b * s, 1.0));
    vec3 L = normalize(LIGHT);
    float diff = max(dot(n, L), 0.0);

    // ambient occlusion: mean sine of the horizon angle over 8 directions
    vec4 ha = max(texture2D(tHorizonA, p) * s, 0.0);
    vec4 hb = max(texture2D(tHorizonB, p) * s, 0.0);
    vec4 oa = ha * inversesqrt(1.0 + ha * ha);
    vec4 ob = hb * inversesqrt(1.0 + hb * hb);
    float occl = dot(oa + ob, vec4(0.125));
    float ao = clamp(1.0 - uAO * occl, 0.0, 1.0);

    // soft cast shadow: is the terrain toward the light steeper than the light?
    float rise = L.z / length(L.xy);
    float shadow = 1.0 - 0.62 * smoothstep(rise * 0.5, rise * 1.6, shade.r * s);

    // cavity: crevices a little darker, crests a little brighter
    float cav = (shade.g - relief.r) * s;
    float cavity = 1.0 - clamp(cav * 24.0, 0.0, 0.25) + clamp(-cav * 6.0, 0.0, 0.05);

    // crisp light on convex rims (petal edges, feather shafts, berries)
    float curv = -relief.a * s;
    vec2 nxy = n.xy + 1e-5;
    float toLight = max(dot(normalize(nxy), normalize(L.xy)), 0.0);
    float rim = smoothstep(0.25, 1.6, curv) * (0.35 + 0.65 * toLight);

    const float amb = 0.5;
    const float kd = 0.75;
    float lit = (amb * ao + kd * diff * shadow * mix(1.0, ao, 0.4)) / (amb + kd * L.z);
    vec3 plaster = uColor * lit * cavity;
    // occluded plaster cools slightly, like a studio render's bounce light
    plaster *= mix(vec3(0.95, 0.965, 1.0), vec3(1.0), ao);
    vec3 R = reflect(-L, n);
    float spec = pow(max(R.z, 0.0), 24.0);
    plaster += (rim * 0.09 + spec * 0.05) * lk * shadow;

    // dark polished stone: little diffuse, glossy highlights catch the edges
    float edge = smoothstep(0.04, 0.4, 1.0 - n.z);
    float gloss = pow(max(R.z, 0.0), 10.0);
    float rimS = smoothstep(0.02, 0.5, 1.0 - n.z) * toLight;
    float facing = max(dot(n, L), 0.0) - L.z; // > 0 on slopes turned to the light
    vec3 stone = uDarkColor * (0.8 + 1.2 * (lit - 1.0)) * mix(1.0, ao * shadow, 0.75);
    stone += vec3(0.24, 0.25, 0.29) * max(facing, 0.0) * k * shadow;
    stone += vec3(0.62, 0.66, 0.72) * (gloss * 0.8 + rimS * 0.35 + rim * 0.5) * k * shadow;

    vec3 col = mix(plaster, stone, uDark);

    // iridescent, fresnel-masked tint on steep faces: strongest where the
    // trail is fast, a faint pearl on anything raised
    float vel = clamp(length(flow.rg) * 1.5, 0.0, 1.0);
    vec3 hue = 0.5 + 0.5 * cos(6.2831 * (n.x * 0.6 + n.y * 0.4 + phase * 0.3 + vec3(0.0, 0.33, 0.67)));
    col = mix(col, col * (0.8 + 0.4 * hue), edge * (vel * mix(0.22, 0.6, uDark) + lk * 0.07));

    // grain, soft light falloff, dithering
    float grain = texture2D(tGrain, p).r;
    col *= mix(0.965 + 0.06 * grain, 0.9 + 0.2 * grain, uDark);
    float vign = length((vUv - vec2(0.25, 0.85)) * vec2(1.0, uAspect));
    col *= mix(1.02 - 0.07 * vign, 1.12 - 0.35 * vign, uDark);
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
