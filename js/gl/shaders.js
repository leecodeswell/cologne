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

    float g = stamp(vUv, uGhost, uFalloff * 1.25);
    data.a += uGhostAmount * g * n2 * uDelta * 0.05;

    for (int i = 0; i < SWELL_COUNT; i++) {
      vec4 sw = uSwells[i];
      if (sw.z <= 0.0) continue;
      float n3 = 0.35 + 0.65 * smoothstep(0.2, 0.9, noise(nuv * 4.0 + float(i) * 7.3 + uTime * 0.05));
      data.a += sw.z * stamp(vUv, sw.xy, sw.w) * n3 * uDelta * 0.06;
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
// The plaster wall. Lit per pixel from the height map; the flowmap scales the
// relief depth so motifs rise where the cursor has been.
// --------------------------------------------------------------------------
export const reliefFrag = /* glsl */ `
  precision highp float;
  uniform sampler2D tHeight;
  uniform sampler2D tCavity;
  uniform sampler2D tFlow;
  uniform vec2 uTexel;       // 1 / height map size
  uniform float uAspect;     // viewport height / width
  uniform float uScroll;     // wall offset in tile units
  uniform float uTime;
  uniform float uRest;       // relief depth with no cursor activity
  uniform float uReveal;     // intro, 0 → 1
  uniform float uDepth;
  uniform float uFlat;
  uniform vec3 uColor;
  uniform vec3 uDarkColor;
  uniform float uDark;       // 0 = plaster, 1 = dark polished stone
  varying vec2 vUv;

  const vec3 LIGHT = vec3(-0.52, 0.62, 0.58);

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  float H(vec2 p) { return texture2D(tHeight, p).r - uFlat; }

  void main() {
    // wall coordinates: x spans the viewport, y scrolls (tile is square)
    float wallY = (1.0 - vUv.y) * uAspect + uScroll;
    vec2 p = vec2(vUv.x, 1.0 - wallY);

    vec4 flow = texture2D(tFlow, vUv);
    float lift = clamp(max(flow.b, flow.a), 0.0, 1.0);
    lift = lift * lift * (3.0 - 2.0 * lift);
    float k = mix(uRest, 1.0, lift) * uReveal;

    // normal from height gradient, scaled by how far the relief is raised
    vec2 e = uTexel;
    float hx = H(p + vec2(e.x, 0.0)) - H(p - vec2(e.x, 0.0));
    float hy = H(p + vec2(0.0, e.y)) - H(p - vec2(0.0, e.y));
    float s = uDepth * k;
    vec3 n = normalize(vec3(-hx * s, -hy * s, 1.0));

    vec3 L = normalize(LIGHT);
    float diff = max(dot(n, L), 0.0);

    // soft self-shadowing: march toward the light over the height field
    float h0 = H(p);
    vec2 dir = normalize(L.xy);
    float rise = L.z / length(L.xy);
    float occ = 0.0;
    for (int i = 1; i <= 10; i++) {
      float t = float(i) * 2.6;
      float hq = H(p + dir * e * t);
      float d = (hq - h0) * uDepth * 0.5 - t * rise;
      occ = max(occ, d / t);
    }
    float shadow = 1.0 - clamp(occ * 2.2 * k, 0.0, 0.42);

    // cavity: darker in crevices, slightly brighter on crests
    float cav = (texture2D(tCavity, p).r - uFlat - h0) * k;
    float ao = 1.0 - clamp(cav * 2.2, 0.0, 0.45) + clamp(-cav * 0.6, 0.0, 0.06);

    const float amb = 0.6;
    const float kd = 0.5;
    float lit = (amb + kd * diff) / (amb + kd * L.z);

    vec3 plaster = uColor * lit * shadow * ao;

    // faint sheen while the cursor is moving
    vec3 R = reflect(-L, n);
    float spec = pow(max(R.z, 0.0), 28.0);
    plaster += spec * 0.05 * lift;

    // dark polished stone: little diffuse, glossy highlights catch the edges
    float edge = smoothstep(0.04, 0.4, 1.0 - n.z);
    float gloss = pow(max(R.z, 0.0), 10.0);
    float rim = smoothstep(0.02, 0.5, 1.0 - n.z) * max(dot(normalize(n.xy + 1e-5), normalize(L.xy)), 0.0);
    float facing = max(dot(n, L), 0.0) - L.z; // > 0 on slopes turned to the light
    vec3 stone = uDarkColor * (0.8 + 1.2 * (lit - 1.0)) * shadow * mix(1.0, ao, 0.7);
    stone += vec3(0.24, 0.25, 0.29) * max(facing, 0.0) * k;
    stone += vec3(0.62, 0.66, 0.72) * (gloss * 0.85 + rim * 0.4) * k;

    vec3 col = mix(plaster, stone, uDark);

    // iridescent hint on steep edges where the trail is fast
    float vel = clamp(length(flow.rg) * 1.5, 0.0, 1.0);
    vec3 hue = 0.5 + 0.5 * cos(6.2831 * (n.x * 0.6 + n.y * 0.4 + vec3(0.0, 0.33, 0.67)));
    col = mix(col, col * (0.8 + 0.4 * hue), vel * edge * mix(0.22, 0.6, uDark));

    // grain, soft light falloff, dithering
    float grain = fbm(p * vec2(220.0, 220.0));
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

    // bloom + halation from two rings of highlight samples
    vec3 bloom = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398 + 0.39;
      vec2 dir = vec2(cos(a), sin(a));
      bloom += bright(uv + dir * texel * 7.0) * 0.6;
      bloom += bright(uv + dir * texel * 18.0) * 0.4;
    }
    bloom /= 8.0;
    col += bloom * vec3(1.0, 0.9, 0.82) * 0.55;

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
