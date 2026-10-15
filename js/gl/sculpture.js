// Builds the bas-relief as real 3D geometry: cupped, curled petals, leaves
// with a midrib, arch and twist, tapered stems and vines, birds with fanned
// feathers, citrus slices and a faceted flacon. The scene is rendered once,
// top-down and orthographic, into a height map (see scene.js).
//
// Coordinates: x runs across the tile (0..1), y runs down the tile (0..1, as
// in a canvas), z is height above the wall in tile widths. Positions are
// emitted with y flipped (v = 1 - y) so they line up with texture space.
// Each vertex also carries a motif phase (0..1, one per motif) and a "sway"
// weight (0 at petal/feather roots, up to 1 at wing tips) that the wall shader
// uses for the gentle per-motif motion.
//
// No dependencies, so it can run in a worker (sculpture.worker.js).

export const DEPTH_SCALE = 0.8; // global compression of the sculpture's height

const TAU = Math.PI * 2;
const PI = Math.PI;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Local frame: rotate in the wall plane, scale, then move. Local z is scaled
// too, so every motif is modelled in units of its own size. Writes into `o`
// when given (the hot path), otherwise returns a new [x, y, z].
function frame(x, y, z, ang, sc) {
  const c = Math.cos(ang) * sc;
  const s = Math.sin(ang) * sc;
  return (lx, ly, lz, o = [0, 0, 0]) => {
    o[0] = x + lx * c - ly * s;
    o[1] = y + lx * s + ly * c;
    o[2] = z + lz * sc;
    return o;
  };
}

// Uniform Catmull-Rom spline through points [x, y, z], t in 0..1.
function catmullRom(pts, t) {
  const m = pts.length - 1;
  const seg = Math.min(m - 1, Math.floor(t * m));
  const f = t * m - seg;
  const p0 = pts[Math.max(0, seg - 1)];
  const p1 = pts[seg];
  const p2 = pts[seg + 1];
  const p3 = pts[Math.min(m, seg + 2)];
  const f2 = f * f;
  const f3 = f2 * f;
  const c = (k) =>
    0.5 * (2 * p1[k] + (p2[k] - p0[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * f3);
  return { x: c(0), y: c(1), z: c(2) };
}

// Width profiles along a blade, u = 0 at the root and 1 at the tip.
const PROFILES = {
  petal: (u) => Math.sqrt(Math.sin(PI * u * Math.sqrt(u))), // broad, round tip
  leaf: (u) => Math.pow(Math.sin(PI * u), 0.85) * (1 - 0.3 * u), // pointed tip
  lance: (u) => Math.pow(Math.sin(PI * Math.pow(u, 0.7)), 0.8), // long and narrow
  feather: (u) => Math.pow(Math.sin(PI * Math.min(1, 0.06 + u * 0.94)), 0.4),
};

// ---------------------------------------------------------------------------
// Geometry accumulator (typed arrays, grown by doubling).
// ---------------------------------------------------------------------------
class Sculpt {
  constructor(detail = 1) {
    this.detail = detail;
    this.pos = new Float32Array(3 << 18);
    this.motif = new Float32Array(2 << 18);
    this.index = new Uint32Array(6 << 18);
    this.nv = 0;
    this.ni = 0;
    this.out = [0, 0, 0, 0];
  }

  reserve(verts, idx) {
    const grow = (arr, need) => {
      if (need <= arr.length) return arr;
      const next = new arr.constructor(Math.max(need, arr.length * 2));
      next.set(arr);
      return next;
    };
    this.pos = grow(this.pos, (this.nv + verts) * 3);
    this.motif = grow(this.motif, (this.nv + verts) * 2);
    this.index = grow(this.index, this.ni + idx);
  }

  // A (nu x nv) grid surface; fn(u, v, out) writes [x, y, z, sway] into out.
  grid(nu, nv, fn, phase) {
    nu = Math.max(2, Math.round(nu * this.detail));
    nv = Math.max(2, Math.round(nv * this.detail));
    const row = nu + 1;
    this.reserve(row * (nv + 1), nu * nv * 6);
    const { pos, motif, index, out } = this;
    const base = this.nv;
    let v3 = base * 3;
    let v2 = base * 2;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        out[3] = 0;
        fn(i / nu, j / nv, out);
        pos[v3++] = out[0];
        pos[v3++] = 1 - out[1];
        pos[v3++] = (out[2] > 0 ? out[2] : 0) * DEPTH_SCALE;
        motif[v2++] = phase;
        motif[v2++] = out[3];
      }
    }
    let k = this.ni;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i;
        index[k++] = a;
        index[k++] = a + 1;
        index[k++] = a + row + 1;
        index[k++] = a;
        index[k++] = a + row + 1;
        index[k++] = a + row;
      }
    }
    this.ni = k;
    this.nv = base + row * (nv + 1);
  }

  // Petal, leaf or feather. The centerline starts at the root, rises at
  // `tilt`, arches by `bend` and rolls over at the tip by `curl` (positive
  // rolls the tip back toward the wall). Across the blade: `cup` lifts the
  // edges, `fold` creases it along the midrib, `ruffle` waves the rim and
  // `twist` rotates the cross-section toward the tip.
  blade(T, o, phase) {
    const {
      len,
      wid,
      tilt = 0.3,
      bend = 0,
      curl = 0,
      cup = 0,
      fold = 0,
      twist = 0,
      ruffle = 0,
      rufFreq = 6,
      midrib = 0,
      veins = 0,
      lobes = 0,
      shape = "petal",
      sway0 = 0,
      sway1 = 0.5,
      seed = 0,
      nu = 12,
      nv = 7,
    } = o;
    const profile = PROFILES[shape];
    const K = 32;
    const cx = new Float32Array(K + 1);
    const cz = new Float32Array(K + 1);
    const th = new Float32Array(K + 1);
    let x = 0;
    let z = 0;
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const a = tilt - bend * u - curl * u * u * u;
      cx[k] = x;
      cz[k] = z;
      th[k] = a;
      x += (Math.cos(a) * len) / K;
      z += (Math.sin(a) * len) / K;
    }
    // per-row values are cached: the grid walks u fastest
    let lastU = -1;
    let px = 0;
    let pz = 0;
    let sa = 0;
    let ca = 1;
    let wp = 0;
    let ct = 1;
    let st = 0;
    let rufU = 0;
    let sway = 0;
    const rows = [];
    this.grid(
      nu,
      nv,
      (u, v, out) => {
        if (u !== lastU) {
          lastU = u;
          let row = rows[Math.round(u * 1000)];
          if (!row) {
            const kf = u * K;
            const k0 = Math.min(K - 1, Math.floor(kf));
            const f = kf - k0;
            const a = th[k0] + (th[k0 + 1] - th[k0]) * f;
            let w = wid * profile(u);
            if (lobes) w *= 1 - lobes * Math.pow(Math.abs(Math.sin(u * PI * 4.5)), 3) * u;
            row = rows[Math.round(u * 1000)] = [
              cx[k0] + (cx[k0 + 1] - cx[k0]) * f,
              cz[k0] + (cz[k0 + 1] - cz[k0]) * f,
              Math.sin(a),
              Math.cos(a),
              w,
              Math.cos(twist * u),
              Math.sin(twist * u),
              u * rufFreq * PI + seed,
              sway0 + (sway1 - sway0) * u * Math.sqrt(u),
            ];
          }
          [px, pz, sa, ca, wp, ct, st, rufU, sway] = row;
        }
        const s = v * 2 - 1;
        const as = s < 0 ? -s : s;
        const ly = s * wp;
        let n = cup * s * s * wp + fold * as * wp;
        if (ruffle) n += ruffle * wp * Math.sin(rufU + s * 2.1) * as * as * (0.3 + u);
        if (midrib) n += midrib * wid * Math.exp(-s * s * 50) * (1 - u * 0.8);
        if (veins) {
          const c = Math.cos(TAU * (u * 5 - as * 0.8));
          if (c > 0) n -= veins * wid * c * c * c * c * c * c * as * (1 - as);
        }
        const ry = ly * ct - n * st;
        const rn = ly * st + n * ct;
        T(px - rn * sa, ry, pz + rn * ca, out);
        out[3] = sway;
      },
      phase
    );
  }

  // Upper half of an ellipsoid, centred at the frame origin.
  ellipsoid(T, rx, ry, rz, phase, sway = 0, segs = 16) {
    this.grid(
      segs,
      Math.max(4, segs / 2),
      (u, v, out) => {
        const a = u * TAU;
        const b = v * PI * 0.5;
        const cb = Math.cos(b);
        T(Math.cos(a) * cb * rx, Math.sin(a) * cb * ry, Math.sin(b) * rz, out);
        out[3] = sway;
      },
      phase
    );
  }

  // Disc in polar coordinates: zfn(r, a) gives the height, r in 0..1.
  disc(T, zfn, phase, nr = 20, na = 64) {
    this.grid(
      na,
      nr,
      (u, v, out) => {
        const a = u * TAU;
        T(Math.cos(a) * v, Math.sin(a) * v, zfn(v, a), out);
      },
      phase
    );
  }

  // Tapered tube through world points [x, y, z]; only the top half is built.
  tube(points, r0, r1, phase, sway = 0, segs = 7) {
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    const n = Math.max(4, Math.round(length * 700 * this.detail));
    const P = [];
    for (let i = 0; i <= n; i++) P.push(catmullRom(points, i / n));
    const sides = P.map((p, i) => {
      const a = P[Math.min(n, i + 1)];
      const b = P[Math.max(0, i - 1)];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    });
    this.grid(
      n,
      segs,
      (u, v, out) => {
        const i = Math.round(u * n);
        const p = P[i];
        const side = sides[i];
        const r = (r0 + (r1 - r0) * u) * Math.pow(Math.sin(PI * Math.min(1, 0.02 + u * 0.98)), 0.15);
        const c = Math.cos(v * PI) * r;
        out[0] = p.x + c * side[0];
        out[1] = p.y + c * side[1];
        out[2] = p.z + Math.sin(v * PI) * r;
        out[3] = sway * u;
      },
      phase
    );
  }

  // Half a lathe body lying on the wall: profile(t) gives the radius along
  // its axis (t 0..1 from top to bottom). `segs` low = faceted glass.
  lathe(x, y, ang, length, profile, flat, phase, segs = 24, nt = 40) {
    const T = frame(x, y, 0, ang, 1);
    this.grid(
      nt,
      segs,
      (u, v, out) => {
        const r = profile(u);
        const a = v * PI;
        T((u - 0.5) * length, Math.cos(a) * r, Math.sin(a) * r * flat, out);
      },
      phase
    );
  }

  // Plain typed arrays, so the build can run in a worker and be transferred.
  build() {
    return {
      position: this.pos.slice(0, this.nv * 3),
      motif: this.motif.slice(0, this.nv * 2),
      index: this.index.slice(0, this.ni),
    };
  }
}

// ---------------------------------------------------------------------------
// Motifs. (x, y) in tile units, sizes in tile widths, z0 = base height.
// ---------------------------------------------------------------------------

// Garden rose: five rings of cupped petals, each ring tilted up more steeply
// and curled tighter, around a closed bud.
function rose(S, rand, x, y, R, z0, phase) {
  const rings = [
    // n, root radius, length, half-width, tilt, curl, cup, base z
    [6, 0.16, 0.86, 0.62, 0.12, 1.2, 0.4, 0.0],
    [6, 0.13, 0.7, 0.58, 0.38, 1.0, 0.6, 0.05],
    [5, 0.1, 0.54, 0.54, 0.66, 0.7, 0.8, 0.11],
    [4, 0.07, 0.4, 0.5, 0.9, 0.4, 1.0, 0.17],
  ];
  const twist = rand() * TAU;
  rings.forEach(([n, r0, len, wid, tilt, curl, cup, zr], k) => {
    for (let i = 0; i < n; i++) {
      const a = twist + k * 2.4 + (i / n) * TAU + (rand() - 0.5) * 0.3;
      const T = frame(x + Math.cos(a) * r0 * R, y + Math.sin(a) * r0 * R, z0 + zr * R, a, R);
      S.blade(
        T,
        {
          len: len * (0.9 + rand() * 0.2),
          wid: wid * (0.9 + rand() * 0.2),
          tilt,
          curl: curl * (0.8 + rand() * 0.4),
          cup,
          ruffle: 0.06,
          seed: rand() * 9,
          sway1: 0.55 - k * 0.1,
        },
        phase
      );
    }
  });
  // the heart: a closed bud wrapped by three petals
  S.ellipsoid(frame(x, y, z0 + 0.2 * R, twist, R), 0.14, 0.12, 0.2, phase, 0.05, 14);
  for (let i = 0; i < 3; i++) {
    const a = twist + 0.9 + (i / 3) * TAU;
    S.blade(frame(x + Math.cos(a) * 0.05 * R, y + Math.sin(a) * 0.05 * R, z0 + 0.2 * R, a, R), { len: 0.26, wid: 0.3, tilt: 0.95, curl: 0.25, cup: 1.1, nu: 9, nv: 6, sway1: 0.15 }, phase);
  }
}

// Peony: many ruffled petals in loose rings around a domed, crumpled heart.
function peony(S, rand, x, y, R, z0, phase) {
  const twist = rand() * TAU;
  const rings = [
    [9, 0.2, 0.82, 0.42, 0.1, 0.8, 0.5, 0.0],
    [8, 0.17, 0.72, 0.4, 0.3, 0.8, 0.65, 0.04],
    [8, 0.14, 0.6, 0.38, 0.55, 0.7, 0.8, 0.08],
    [7, 0.1, 0.48, 0.34, 0.8, 0.7, 1.0, 0.12],
  ];
  rings.forEach(([n, r0, len, wid, tilt, curl, cup, zr], k) => {
    for (let i = 0; i < n; i++) {
      const a = twist + k * 1.7 + (i / n) * TAU + (rand() - 0.5) * 0.4;
      const T = frame(x + Math.cos(a) * r0 * R, y + Math.sin(a) * r0 * R, z0 + zr * R, a, R);
      S.blade(
        T,
        { len: len * (0.85 + rand() * 0.3), wid, tilt, curl, cup, ruffle: 0.22, rufFreq: 7 + rand() * 4, seed: rand() * 9, sway1: 0.5 - k * 0.08 },
        phase
      );
    }
  });
  // crumpled heart: small upright ruffled petals in a dome
  for (let i = 0; i < 10; i++) {
    const a = rand() * TAU;
    const d = Math.sqrt(rand()) * 0.12;
    const T = frame(x + Math.cos(a) * d * R, y + Math.sin(a) * d * R, z0 + (0.16 - d * 0.5) * R, a + PI * 0.5 * (rand() - 0.5), R);
    S.blade(T, { len: 0.22, wid: 0.15, tilt: 0.8 + rand() * 0.3, curl: 1.0, cup: 1.2, ruffle: 0.3, rufFreq: 8, seed: rand() * 9, nu: 8, nv: 6, sway1: 0.2 }, phase);
  }
}

// Bearded iris: drooping falls, upright standards folding inward, sword leaves.
function iris(S, rand, x, y, s, ang, z0, phase) {
  // stem and leaves first (they sit under the flower)
  const bx = x - Math.cos(ang) * s * 1.6;
  const by = y - Math.sin(ang) * s * 1.6;
  const mid = [x - Math.cos(ang) * s * 0.8 + Math.sin(ang) * s * 0.12, y - Math.sin(ang) * s * 0.8 - Math.cos(ang) * s * 0.12];
  S.tube([[bx, by, z0], [mid[0], mid[1], z0 + 0.03 * s], [x, y, z0 + 0.06 * s]], s * 0.05, s * 0.035, phase);
  for (const [da, l] of [[-0.32, 1.5], [0.38, 1.25], [-0.75, 0.9]]) {
    S.blade(frame(bx, by, z0, ang + da, s), { shape: "lance", len: l, wid: 0.075, tilt: 0.1, bend: 0.12, twist: 0.7 * Math.sign(da), fold: 0.25, midrib: 0.3, nu: 18, nv: 6, sway1: 0.35 }, phase);
  }
  const zc = z0 + 0.1 * s;
  for (let i = 0; i < 3; i++) {
    const a = ang + (i / 3) * TAU;
    S.blade(frame(x + Math.cos(a) * 0.05 * s, y + Math.sin(a) * 0.05 * s, zc, a, s), { len: 0.62, wid: 0.27, tilt: 0.45, curl: 1.7, cup: -0.25, ruffle: 0.25, rufFreq: 5, midrib: 0.25, seed: i, sway1: 0.6 }, phase);
    // beard
    S.tube([[x + Math.cos(a) * 0.06 * s, y + Math.sin(a) * 0.06 * s, zc + 0.1 * s], [x + Math.cos(a) * 0.3 * s, y + Math.sin(a) * 0.3 * s, zc + 0.12 * s]], 0.035 * s, 0.015 * s, phase);
  }
  for (let i = 0; i < 3; i++) {
    const a = ang + PI / 3 + (i / 3) * TAU;
    S.blade(frame(x + Math.cos(a) * 0.04 * s, y + Math.sin(a) * 0.04 * s, zc + 0.08 * s, a, s), { len: 0.5, wid: 0.21, tilt: 1.2, curl: -0.45, cup: 1.1, ruffle: 0.2, seed: i + 3, sway1: 0.5 }, phase);
  }
  S.ellipsoid(frame(x, y, zc + 0.12 * s, ang, s), 0.12, 0.12, 0.22, phase, 0.2, 12);
}

// Lily: six long recurved tepals, stamens fanning out on thin filaments.
function lily(S, rand, x, y, s, ang, z0, phase) {
  for (let i = 0; i < 6; i++) {
    const a = ang + (i / 6) * TAU + (i % 2) * 0.12;
    S.blade(frame(x, y, z0 + (i % 2) * 0.03 * s, a, s), { shape: "lance", len: 0.85 + (i % 2) * 0.08, wid: 0.17, tilt: 0.75, curl: 2.6, cup: 0.6, fold: -0.15, midrib: -0.3, ruffle: 0.1, seed: i, nu: 18, sway1: 0.65 }, phase);
  }
  for (let i = 0; i < 6; i++) {
    const a = ang + 0.5 + (i / 6) * TAU + (rand() - 0.5) * 0.3;
    const l = 0.42 + rand() * 0.12;
    const ex = x + Math.cos(a) * l * s;
    const ey = y + Math.sin(a) * l * s;
    S.tube([[x, y, z0 + 0.15 * s], [x + Math.cos(a) * l * 0.5 * s, y + Math.sin(a) * l * 0.5 * s, z0 + 0.3 * s], [ex, ey, z0 + 0.32 * s]], 0.014 * s, 0.01 * s, phase, 0.5, 5);
    S.ellipsoid(frame(ex, ey, z0 + 0.32 * s, a + PI / 2, s), 0.07, 0.03, 0.03, phase, 0.6, 8);
  }
  S.tube([[x, y, z0 + 0.15 * s], [x + Math.cos(ang + 3.6) * 0.3 * s, y + Math.sin(ang + 3.6) * 0.3 * s, z0 + 0.35 * s]], 0.022 * s, 0.018 * s, phase, 0.3, 5);
}

// Small five-petal blossom (orange blossom / jasmine).
function blossom(S, rand, x, y, s, z0, phase) {
  const tw = rand() * TAU;
  const n = rand() < 0.5 ? 5 : 4;
  for (let i = 0; i < n; i++) {
    const a = tw + (i / n) * TAU;
    S.blade(frame(x, y, z0, a, s), { len: 0.55, wid: 0.3, tilt: 0.35, curl: 0.9, cup: 0.7, ruffle: 0.08, seed: i, nu: 10, nv: 6, sway1: 0.5 }, phase);
  }
  S.ellipsoid(frame(x, y, z0 + 0.06 * s, 0, s), 0.12, 0.12, 0.14, phase, 0.1, 10);
  for (let i = 0; i < 6; i++) {
    const a = tw + (i / 6) * TAU + 0.3;
    S.ellipsoid(frame(x + Math.cos(a) * 0.17 * s, y + Math.sin(a) * 0.17 * s, z0 + 0.14 * s, 0, s), 0.035, 0.035, 0.04, phase, 0.3, 6);
  }
}

// Closed bud on a short stem, held by sepals.
function bud(S, rand, x, y, s, ang, z0, phase) {
  const bx = x - Math.cos(ang) * s * 0.9;
  const by = y - Math.sin(ang) * s * 0.9;
  S.tube([[bx, by, z0], [(x + bx) / 2, (y + by) / 2, z0 + 0.06 * s], [x, y, z0 + 0.12 * s]], 0.05 * s, 0.04 * s, phase);
  S.ellipsoid(frame(x + Math.cos(ang) * 0.12 * s, y + Math.sin(ang) * 0.12 * s, z0 + 0.12 * s, ang, s), 0.3, 0.17, 0.2, phase, 0.3, 12);
  for (const da of [-0.5, 0.5, 0]) {
    S.blade(frame(x, y, z0 + 0.12 * s, ang + da, s), { shape: "leaf", len: 0.36, wid: 0.08, tilt: 0.45, curl: 0.4, cup: 0.6, nu: 8, nv: 5, sway1: 0.4 }, phase);
  }
}

// Leaf with a short petiole, real midrib, arch and twist.
function leafMotif(S, rand, x, y, len, ang, z0, phase, o = {}) {
  S.blade(
    frame(x, y, z0, ang, len),
    {
      shape: "leaf",
      len: 1,
      wid: o.wid ?? 0.22 + rand() * 0.08,
      tilt: o.tilt ?? 0.32 + rand() * 0.15,
      bend: o.bend ?? 0.5 + rand() * 0.3,
      curl: o.curl ?? 0.1,
      fold: o.fold ?? 0.3,
      twist: o.twist ?? (rand() - 0.5) * 1.2,
      midrib: 0.12,
      veins: 0.05,
      lobes: o.lobes ?? 0,
      ruffle: o.ruffle ?? 0.05,
      seed: rand() * 9,
      nu: 16,
      nv: 9,
      sway1: 0.35,
    },
    phase
  );
}

// Bird in flight seen from above: fanned primaries and coverts, tail, head.
function bird(S, rand, x, y, s, ang, z0, phase) {
  const T = frame(x, y, z0, ang, s);
  const at = (lx, ly) => {
    const p = T(lx, ly, 0);
    return [p[0], p[1]];
  };
  // tail
  for (let i = 0; i < 7; i++) {
    const a = ang + PI + (i / 6 - 0.5) * 0.8;
    const [px, py] = at(-0.26, (i / 6 - 0.5) * 0.06);
    S.blade(frame(px, py, z0 + 0.03 * s + i * 0.002 * s, a, s), { shape: "feather", len: 0.42 - Math.abs(i - 3) * 0.02, wid: 0.06, tilt: 0.06, curl: 0.15, cup: 0.4, midrib: 0.25, nu: 10, nv: 5, sway1: 0.5 }, phase);
  }
  // wings
  for (const sd of [-1, 1]) {
    for (const row of [0, 1]) {
      const n = row ? 7 : 11;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const reach = row ? 0.3 : 0.5;
        const [px, py] = at(0.08 - t * 0.02, sd * (0.06 + t * reach));
        const a = ang + sd * (PI - t * (PI / 2 - 0.25));
        const len = row ? 0.18 + 0.12 * t : 0.3 + 0.42 * Math.pow(t, 1.2);
        S.blade(
          frame(px, py, z0 + (row ? 0.06 : 0.03) * s + (1 - t) * 0.02 * s, a, s),
          { shape: "feather", len, wid: row ? 0.07 : 0.06, tilt: 0.12, curl: 0.25, cup: 0.35, midrib: 0.2, nu: 10, nv: 5, sway0: 0.4 * t, sway1: 0.5 + 0.5 * t },
          phase
        );
      }
    }
  }
  // body, head, beak
  S.ellipsoid(frame(x, y, z0 + 0.03 * s, ang, s), 0.3, 0.13, 0.15, phase, 0.15, 16);
  const [hx, hy] = at(0.28, 0);
  S.ellipsoid(frame(hx, hy, z0 + 0.07 * s, ang, s), 0.11, 0.095, 0.11, phase, 0.15, 12);
  const [b0x, b0y] = at(0.37, 0);
  const [b1x, b1y] = at(0.47, 0);
  S.tube([[b0x, b0y, z0 + 0.1 * s], [b1x, b1y, z0 + 0.06 * s]], 0.03 * s, 0.006 * s, phase, 0.1, 5);
}

// Butterfly: four broad wings and a slim body.
function butterfly(S, rand, x, y, s, ang, z0, phase) {
  for (const sd of [-1, 1]) {
    S.blade(frame(x, y, z0, ang + sd * 1.0, s), { len: 0.62, wid: 0.36, tilt: 0.3, curl: 0.3, cup: 0.3, ruffle: 0.1, veins: 0.06, sway1: 1 }, phase);
    S.blade(frame(x, y, z0 + 0.01 * s, ang + sd * 2.2, s), { len: 0.46, wid: 0.26, tilt: 0.25, curl: 0.3, cup: 0.3, veins: 0.06, sway1: 0.9 }, phase);
  }
  S.ellipsoid(frame(x, y, z0 + 0.04 * s, ang, s), 0.3, 0.05, 0.06, phase, 0.1, 10);
  for (const sd of [-1, 1]) {
    const T = frame(x, y, z0, ang, s);
    S.tube([T(0.28, 0, 0.08), T(0.42, sd * 0.06, 0.1), T(0.5, sd * 0.14, 0.09)], 0.008 * s, 0.006 * s, phase, 0.6, 4);
  }
}

// Bee: striped domed body with veined wings.
function bee(S, rand, x, y, s, ang, z0, phase) {
  for (const sd of [-1, 1]) {
    S.blade(frame(x, y, z0 + 0.04 * s, ang + sd * 2.0, s), { shape: "feather", len: 0.6, wid: 0.18, tilt: 0.2, curl: 0.2, cup: 0.3, veins: 0.08, sway1: 1 }, phase);
  }
  const T = frame(x, y, z0, ang, s);
  for (let i = 0; i < 4; i++) {
    const p = T(-0.12 - i * 0.1, 0, 0);
    S.ellipsoid(frame(p[0], p[1], z0, ang, s), 0.075, 0.16 - i * 0.025, 0.17 - i * 0.03, phase, 0.1, 10);
  }
  const h = T(0.12, 0, 0);
  S.ellipsoid(frame(h[0], h[1], z0, ang, s), 0.1, 0.11, 0.13, phase, 0.1, 10);
}

// Citrus slice (bergamot): rind bead around domed segments.
function citrus(S, rand, x, y, r, z0, phase) {
  const n = 10;
  const rot = rand() * TAU;
  S.disc(
    frame(x, y, z0, rot, r),
    (rr, a) => {
      const f = ((a / TAU) * n) % 1;
      const seg = Math.pow(Math.sin(PI * f), 0.35) * Math.sin(PI * Math.min(1, Math.max(0, (rr - 0.1) / 0.74))) ** 0.6;
      const pith = rr < 0.86 ? 0.05 + 0.12 * seg : 0;
      const rind = 0.16 * Math.sqrt(Math.max(0, 1 - ((rr - 0.92) / 0.08) ** 2));
      return Math.max(pith, rind, rr < 0.1 ? 0.12 : 0) * smooth(1.0, 0.97, rr);
    },
    phase,
    26,
    140
  );
}

// Whole lemon with a pointed nib and two leaves.
function lemon(S, rand, x, y, s, ang, z0, phase) {
  leafMotif(S, rand, x - Math.cos(ang) * s * 0.3, y - Math.sin(ang) * s * 0.3, s * 1.1, ang + 2.4, z0, phase);
  leafMotif(S, rand, x - Math.cos(ang) * s * 0.3, y - Math.sin(ang) * s * 0.3, s * 0.9, ang - 2.6, z0, phase);
  S.ellipsoid(frame(x, y, z0, ang, s), 0.42, 0.32, 0.3, phase, 0.05, 20);
  const T = frame(x, y, z0, ang, s);
  const n = T(0.42, 0, 0);
  S.ellipsoid(frame(n[0], n[1], z0, ang, s), 0.1, 0.07, 0.12, phase, 0.05, 8);
}

// Perfume flacon: faceted half-lathe body, neck, cut stopper, label ring.
function flacon(S, x, y, H, phase) {
  const w = H * 0.31;
  S.lathe(
    x,
    y + H * 0.17,
    PI / 2,
    H * 0.66,
    (t) => {
      const shoulder = smooth(0, 0.22, t);
      const foot = smooth(1, 0.94, t);
      return w * (0.28 + 0.72 * Math.sqrt(shoulder)) * (0.85 + 0.15 * foot) * (0.97 + 0.03 * Math.sin(t * PI));
    },
    0.42,
    phase,
    12,
    40
  );
  S.lathe(x, y - H * 0.2, PI / 2, H * 0.1, () => w * 0.26, 0.5, phase, 16, 4);
  S.lathe(x, y - H * 0.34, PI / 2, H * 0.2, (t) => w * 0.5 * Math.sin(PI * Math.min(1, 0.08 + t * 0.92)) ** 0.7, 0.75, phase, 6, 16);
  // engraved label: an oval bead on the glass
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * TAU;
    pts.push([x + Math.cos(a) * w * 0.5, y + H * 0.2 + Math.sin(a) * H * 0.12, w * 0.4]);
  }
  S.tube(pts, H * 0.012, H * 0.012, phase);
}

// Laurel branch along a quadratic curve, leaves in pairs (or one side).
function laurel(S, rand, x0, y0, cx, cy, x1, y1, leafLen, z0, phase, side = 0) {
  const pt = (t) => [
    (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1,
    (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1,
  ];
  const tan = (t) => Math.atan2(2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy), 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx));
  const stem = [];
  for (let i = 0; i <= 8; i++) {
    const [px, py] = pt(i / 8);
    stem.push([px, py, z0]);
  }
  S.tube(stem, leafLen * 0.07, leafLen * 0.03, phase);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = 0.05 + (i / n) * 0.9;
    const [px, py] = pt(t);
    const a = tan(t);
    const sc = 1 - t * 0.4;
    for (const sd of side ? [side] : [-1, 1]) {
      leafMotif(S, rand, px, py, leafLen * sc * (0.9 + rand() * 0.2), a + sd * (0.55 + rand() * 0.2), z0 + 0.002, phase, { wid: 0.2, tilt: 0.5, bend: 0.7, twist: sd * 0.5, fold: 0.35 });
    }
    if (rand() < 0.3) {
      const o = a + (rand() < 0.5 ? 1 : -1) * PI * 0.5;
      S.ellipsoid(frame(px + Math.cos(o) * leafLen * 0.3, py + Math.sin(o) * leafLen * 0.3, z0, 0, leafLen), 0.1, 0.1, 0.12, phase, 0.1, 10);
    }
  }
  const [tx, ty] = pt(1);
  leafMotif(S, rand, tx, ty, leafLen * 0.6, tan(1), z0, phase, { wid: 0.18, tilt: 0.5 });
}

// Medallion disc: bevelled edge, raised bead rim and a fine inner ring.
// The "LI" letters come from the carved canvas layer (heightmap.js).
export const MEDALLION = { x: 0.72, y: 0.27, r: 0.085, h: 0.11 }; // h = field height / r
function medallion(S, phase) {
  const { x, y, r, h } = MEDALLION;
  S.disc(
    frame(x, y, 0, 0, r),
    (rr) => {
      const field = h * smooth(1.0, 0.86, rr);
      const bead = 0.075 * Math.exp(-(((rr - 0.92) / 0.035) ** 2));
      const fine = 0.025 * Math.exp(-(((rr - 0.8) / 0.012) ** 2));
      return field + bead + fine;
    },
    phase,
    90,
    160
  );
}

// Ribbon bow below the wreath: two loops and two trailing tails.
function bow(S, x, y, s, phase) {
  for (const sd of [-1, 1]) {
    S.blade(frame(x, y, 0.004, -PI / 2 + sd * 1.1, s), { len: 0.55, wid: 0.2, tilt: 0.4, curl: 1.4, cup: -0.4, sway1: 0.3 }, phase);
    S.blade(frame(x, y, 0.002, PI / 2 + sd * 0.45, s), { shape: "lance", len: 0.9, wid: 0.1, tilt: 0.15, bend: 0.2, twist: sd * 1.4, sway1: 0.4 }, phase);
  }
  S.ellipsoid(frame(x, y, 0.006, 0, s), 0.13, 0.1, 0.12, phase, 0, 10);
}

// Vine: a wandering stem with alternate leaves, tendrils and buds.
function vine(S, rand, pts, z0, phase, allow) {
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (allow(p[0], p[1])) run.push(p);
    else if (run.length) (runs.push(run), (run = []));
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    if (r.length < 3) continue;
    S.tube(r.map(([px, py]) => [px, py, z0]), 0.0042, 0.0022, phase, 0.1);
    for (let i = 1; i < r.length - 1; i++) {
      const [px, py] = r[i];
      const a = Math.atan2(r[i + 1][1] - r[i - 1][1], r[i + 1][0] - r[i - 1][0]);
      const sd = i % 2 ? 1 : -1;
      const roll = rand();
      if (roll < 0.75) leafMotif(S, rand, px, py, 0.028 + rand() * 0.02, a + sd * (0.7 + rand() * 0.4), z0 + 0.001, phase);
      else if (roll < 0.88) {
        // tendril: a tightening spiral
        const tp = [];
        let ta = a + sd * 1.2;
        let rr = 0.012;
        let tx = px;
        let ty = py;
        for (let k = 0; k < 9; k++) {
          tp.push([tx, ty, z0 + 0.002]);
          tx += Math.cos(ta) * rr;
          ty += Math.sin(ta) * rr;
          ta += sd * 0.75;
          rr *= 0.8;
        }
        S.tube(tp, 0.0016, 0.0008, phase, 0.5, 5);
      } else bud(S, rand, px + Math.cos(a + sd) * 0.012, py + Math.sin(a + sd) * 0.012, 0.022, a + sd * 0.9, z0 + 0.001, phase);
    }
  }
}

// ---------------------------------------------------------------------------
// Composition.
// ---------------------------------------------------------------------------
export const BAND = { y: 0.9, half: 0.034 }; // inscription band (carved canvas)

export function buildSculpture({ seed = 11, detail = 1 } = {}) {
  const S = new Sculpt(detail);
  const rand = mulberry32(seed);
  let motifId = 0;
  const phase = () => ((motifId++ * 0.618034) % 1);

  const wrapDy = (a, b) => {
    let d = Math.abs(a - b) % 1;
    return Math.min(d, 1 - d);
  };
  const ym = (y) => ((y % 1) + 1) % 1;
  const M = MEDALLION;
  const inBand = (y, pad = 0) => wrapDy(y, BAND.y) < BAND.half + 0.016 + pad;
  const medDist = (x, y) => Math.hypot(x - M.x, wrapDy(y, M.y));
  // breathing room behind the hero headline (left, upper half of the tile)
  const quiet = (x, y) => {
    const dx = (x - 0.27) / 0.27;
    const dy = (ym(y) - 0.29) / 0.15;
    return Math.min(1, 1.4 * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)));
  };
  const free = (x, y, pad = 0) => !inBand(y, pad) && medDist(x, y) > M.r * 1.12 + pad;

  // coarse occupancy grid used to fill every gap
  const G = 96;
  const occ = new Uint8Array(G * G);
  const mark = (x, y, r) => {
    const c0 = Math.floor((x - r) * G);
    const c1 = Math.ceil((x + r) * G);
    const r0 = Math.floor((y - r) * G);
    const r1 = Math.ceil((y + r) * G);
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        if (i < 0 || i >= G) continue;
        if (Math.hypot((i + 0.5) / G - x, (j + 0.5) / G - y) > r) continue;
        occ[(((j % G) + G) % G) * G + i] = 1;
      }
    }
  };

  // --- inscription fillets
  for (const dy of [-BAND.half, BAND.half]) {
    S.tube([[0.06, BAND.y + dy, 0], [0.5, BAND.y + dy, 0], [0.94, BAND.y + dy, 0]], 0.0034, 0.0034, phase());
  }

  // --- wreath and medallion
  const mp = phase();
  medallion(S, mp);
  const lp = phase();
  laurel(S, rand, M.x - M.r * 0.2, M.y + M.r * 1.75, M.x - M.r * 2.15, M.y + M.r * 0.6, M.x - M.r * 0.7, M.y - M.r * 1.75, 0.05, 0.001, lp, -1);
  laurel(S, rand, M.x + M.r * 0.2, M.y + M.r * 1.75, M.x + M.r * 2.15, M.y + M.r * 0.6, M.x + M.r * 0.7, M.y - M.r * 1.75, 0.05, 0.001, lp, 1);
  bow(S, M.x, M.y + M.r * 1.8, 0.05, lp);
  mark(M.x, M.y, M.r * 1.9);

  // --- flacon with bergamot
  const F = { x: 0.53, y: 0.63, h: 0.15 };
  flacon(S, F.x, F.y, F.h, phase());
  mark(F.x, F.y, 0.075);

  // --- vines: the green carpet everything else grows over
  const allowVine = (x, y) => !inBand(y, -0.008) && medDist(x, y) > M.r * 1.05 && Math.hypot(x - F.x, wrapDy(y, F.y + 0.02)) > 0.075;
  for (let v = 0; v < 9; v++) {
    let x = rand();
    let y = rand();
    let a = rand() * TAU;
    const pts = [];
    for (let i = 0; i < 34; i++) {
      pts.push([x, y]);
      a += (rand() - 0.5) * 0.9;
      // keep vines on the tile horizontally
      if (x < 0.06) a += (0 - Math.cos(a)) * 0.6;
      if (x > 0.94) a -= (0 - Math.cos(a)) * 0.6;
      x += Math.cos(a) * 0.024;
      y += Math.sin(a) * 0.024;
    }
    vine(S, rand, pts, 0, phase(), (px, py) => allowVine(px, py) && quiet(px, py) < 0.35);
  }

  // --- birds in flight (none for now: removed from the composition; add
  // [x, y, size, angle] entries to bring them back — the fill flows into
  // the space they would take)
  const birds = [];
  for (const [x, y, s, a] of birds) {
    bird(S, rand, x, y, s, a, 0.008, phase());
    mark(x, y, s * 0.6);
  }
  butterfly(S, rand, 0.06, 0.42, 0.05, -1.2, 0.006, phase());
  butterfly(S, rand, 0.62, 0.92 - 0.1, 0.045, 2.2, 0.006, phase());
  bee(S, rand, 0.58, 0.3, 0.035, 0.6, 0.006, phase());
  bee(S, rand, 0.97, 0.7, 0.03, -2.1, 0.006, phase());

  // --- fragrance accents
  const accents = [
    [citrus, 0.41, 0.6, 0.042],
    [citrus, 0.645, 0.71, 0.036],
    [citrus, 0.97, 0.37, 0.034],
    [citrus, 0.22, 0.96 - 0.12, 0.03],
  ];
  for (const [fn, x, y, r] of accents) {
    fn(S, rand, x, y, r, 0.004, phase());
    mark(x, y, r);
  }
  lemon(S, rand, 0.6, 0.52, 0.05, -0.4, 0.004, phase());
  mark(0.6, 0.52, 0.035);

  // --- big blooms, dart-throwing with overlap allowed
  const blooms = [];
  const kinds = [
    [rose, 0.36, 0.034, 0.058],
    [peony, 0.2, 0.042, 0.064],
    [lily, 0.16, 0.05, 0.068],
    [iris, 0.12, 0.045, 0.06],
    [blossom, 0.16, 0.018, 0.026],
  ];
  for (let tries = 0; tries < 1400 && blooms.length < 46; tries++) {
    const x = 0.03 + rand() * 0.94;
    const y = rand();
    let pick = rand();
    let kind = kinds[0];
    for (const k of kinds) {
      if ((pick -= k[1]) <= 0) {
        kind = k;
        break;
      }
    }
    const q = quiet(x, y);
    let R = kind[2] + rand() * (kind[3] - kind[2]);
    if (q > 0) {
      if (rand() < q * 0.9) continue;
      R *= 1 - q * 0.45;
    }
    if (!free(x, y, R * 0.5)) continue;
    if (Math.hypot(x - F.x, wrapDy(y, F.y)) < 0.07 + R * 0.6) continue;
    let ok = true;
    for (const b of blooms) {
      if (Math.hypot(x - b.x, wrapDy(y, b.y)) < (R + b.R) * 0.78) {
        ok = false;
        break;
      }
    }
    for (const [bx, by, bs] of birds) if (Math.hypot(x - bx, wrapDy(y, by)) < R * 0.6 + bs * 0.45) ok = false;
    if (!ok) continue;
    blooms.push({ x, y, R, kind: kind[0] });
  }
  for (const b of blooms) {
    const p = phase();
    const big = b.kind !== blossom;
    // a collar of leaves under each big bloom
    if (big) {
      const n = 3 + Math.floor(rand() * 3);
      const a0 = rand() * TAU;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * TAU + (rand() - 0.5) * 0.6;
        leafMotif(S, rand, b.x + Math.cos(a) * b.R * 0.4, b.y + Math.sin(a) * b.R * 0.4, b.R * (1.2 + rand() * 0.5), a, 0.001, p, { lobes: b.kind === peony ? 0.35 : 0 });
      }
    }
    const z0 = 0.003 + rand() * 0.002;
    const ang = rand() * TAU;
    if (b.kind === rose) rose(S, rand, b.x, b.y, b.R, z0, p);
    else if (b.kind === peony) peony(S, rand, b.x, b.y, b.R, z0, p);
    else if (b.kind === lily) lily(S, rand, b.x, b.y, b.R, ang, z0, p);
    else if (b.kind === iris) iris(S, rand, b.x, b.y, b.R, -PI / 2 + (rand() - 0.5) * 0.8, z0, p);
    else blossom(S, rand, b.x, b.y, b.R, z0, p);
    mark(b.x, b.y, b.R * (big ? 0.95 : 1.2));
  }

  // --- fill every remaining gap with leaves, blossoms, buds and berries
  const cells = [];
  for (let j = 0; j < G; j += 2) for (let i = 2; i < G - 2; i += 2) cells.push([i, j]);
  for (let i = cells.length - 1; i > 0; i--) {
    const k = Math.floor(rand() * (i + 1));
    [cells[i], cells[k]] = [cells[k], cells[i]];
  }
  for (const [i, j] of cells) {
    if (occ[j * G + i]) continue;
    const x = (i + 0.5 + (rand() - 0.5)) / G;
    const y = (j + 0.5 + (rand() - 0.5)) / G;
    if (!free(x, y, 0.004)) continue;
    const q = quiet(x, y);
    if (rand() < q * 0.95) continue;
    const p = phase();
    const sc = 1 - q * 0.4;
    const roll = rand();
    if (roll < 0.45) {
      const a = rand() * TAU;
      for (let k = 0; k < 3; k++) leafMotif(S, rand, x, y, (0.028 + rand() * 0.02) * sc, a + (k - 1) * 0.8, 0.001, p);
      mark(x, y, 0.024 * sc);
    } else if (roll < 0.72) {
      blossom(S, rand, x, y, (0.016 + rand() * 0.01) * sc, 0.003, p);
      mark(x, y, 0.02 * sc);
    } else if (roll < 0.88) {
      bud(S, rand, x, y, 0.024 * sc, rand() * TAU, 0.002, p);
      mark(x, y, 0.018 * sc);
    } else {
      for (let k = 0; k < 5; k++) {
        const a = rand() * TAU;
        const d = rand() * 0.012;
        S.ellipsoid(frame(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.001, 0, 1), 0.0045, 0.0045, 0.005, p, 0.2, 10);
      }
      mark(x, y, 0.014);
    }
  }

  return S.build();
}
