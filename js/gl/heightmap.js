// Procedurally draws the bas-relief as a greyscale height map on a 2D canvas.
// Black = deepest (carved), FLAT = the plaster wall, white = highest relief.
// The map tiles vertically so the wall can scroll forever.
// Every motif is drawn with gradients / stacked strokes so it has a rounded
// profile; the GPU blurs it afterwards to smooth out 8-bit steps.

export const FLAT = 0.16;

const grey = (v) => {
  const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c},${c},${c})`;
};

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createHeightCanvas(size = 2048, seed = 7) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  let rand = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rand();
  const S = size;

  ctx.fillStyle = grey(FLAT);
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Draw the composition three times (y - S, y, y + S) so it tiles vertically.
  // The RNG restarts each pass so all three copies are identical.
  const tiled = (fn) => {
    for (const dy of [-S, 0, S]) {
      rand = mulberry32(seed);
      ctx.save();
      ctx.translate(0, dy);
      fn();
      ctx.restore();
    }
  };

  // ---------------------------------------------------------------- primitives

  // Stroke with a rounded cross-section: wide+low, then narrower+higher.
  function roundStroke(path, width, h) {
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      const k = i / (steps - 1);
      ctx.lineWidth = width * (1 - k * 0.8);
      ctx.strokeStyle = grey(FLAT + (h - FLAT) * Math.sqrt(0.35 + 0.65 * k));
      ctx.stroke(path);
    }
  }

  // Almond leaf with a central vein, lying along +x from the origin.
  function leaf(x, y, len, wid, angle, h, bend = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const p = new Path2D();
    p.moveTo(0, 0);
    p.bezierCurveTo(len * 0.25, -wid * 1.1 + bend * len, len * 0.7, -wid * 0.9 + bend * len, len, bend * len * 1.4);
    p.bezierCurveTo(len * 0.7, wid * 0.9 + bend * len, len * 0.25, wid * 1.1 + bend * len, 0, 0);
    const g = ctx.createLinearGradient(0, -wid, 0, wid);
    g.addColorStop(0, grey(FLAT + 0.05));
    g.addColorStop(0.42, grey(h));
    g.addColorStop(0.5, grey(h - 0.02));
    g.addColorStop(0.58, grey(h - 0.06));
    g.addColorStop(1, grey(FLAT + 0.03));
    ctx.fillStyle = g;
    ctx.fill(p);
    // vein
    const v = new Path2D();
    v.moveTo(len * 0.04, 0);
    v.quadraticCurveTo(len * 0.5, bend * len * 0.6, len * 0.92, bend * len * 1.3);
    ctx.lineWidth = Math.max(1.5, wid * 0.08);
    ctx.strokeStyle = grey(h - 0.12);
    ctx.stroke(v);
    ctx.restore();
  }

  function berry(x, y, r, h) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    g.addColorStop(0, grey(h));
    g.addColorStop(0.7, grey(h - 0.12));
    g.addColorStop(1, grey(FLAT + 0.04));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Laurel branch following a quadratic curve.
  function laurel(x0, y0, cx, cy, x1, y1, leafLen, h, opts = {}) {
    const { side = 0, berries = true } = opts;
    const stem = new Path2D();
    stem.moveTo(x0, y0);
    stem.quadraticCurveTo(cx, cy, x1, y1);
    roundStroke(stem, leafLen * 0.11, h - 0.12);

    const pt = (t) => ({
      x: (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1,
      y: (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1,
    });
    const tan = (t) => Math.atan2(2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy), 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx));

    const n = Math.round(R(9, 12));
    for (let i = 0; i < n; i++) {
      const t = 0.06 + (i / n) * 0.9;
      const p = pt(t);
      const a = tan(t);
      const scale = 1 - t * 0.45;
      for (const s of side ? [side] : [-1, 1]) {
        const spread = R(0.5, 0.75) * s;
        leaf(p.x, p.y, leafLen * scale * R(0.9, 1.1), leafLen * 0.2 * scale, a + spread, h - R(0, 0.05), R(-0.06, 0.06) * s);
      }
      if (berries && rand() < 0.22) {
        const o = a + Math.PI / 2 * (rand() < 0.5 ? 1 : -1);
        berry(p.x + Math.cos(o) * leafLen * 0.35, p.y + Math.sin(o) * leafLen * 0.35, leafLen * 0.09, h);
      }
    }
    const tip = pt(1);
    leaf(tip.x, tip.y, leafLen * 0.6, leafLen * 0.12, tan(1), h);
  }

  // Layered rosette (rose / peony), rings of cupped petals.
  function rosette(x, y, r, h) {
    const rings = [
      { n: 9, r0: 0.45, r1: 1.0, w: 0.42, h0: FLAT + 0.12, h1: h - 0.28 },
      { n: 7, r0: 0.3, r1: 0.74, w: 0.5, h0: h - 0.3, h1: h - 0.14 },
      { n: 5, r0: 0.16, r1: 0.48, w: 0.6, h0: h - 0.16, h1: h - 0.04 },
    ];
    const twist = R(0, Math.PI * 2);
    rings.forEach((ring, k) => {
      for (let i = 0; i < ring.n; i++) {
        const a = twist + (i / ring.n) * Math.PI * 2 + k * 0.35 + R(-0.08, 0.08);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        const r0 = r * ring.r0;
        const r1 = r * ring.r1 * R(0.92, 1.05);
        const w = r * ring.w * 0.55;
        const p = new Path2D();
        p.moveTo(r0, 0);
        p.bezierCurveTo(r0 + (r1 - r0) * 0.2, -w, r1 + w * 0.1, -w * 0.9, r1, 0);
        p.bezierCurveTo(r1 + w * 0.1, w * 0.9, r0 + (r1 - r0) * 0.2, w, r0, 0);
        // cupped: higher rim, dipping toward the middle
        const g = ctx.createRadialGradient(r0, 0, 0, r0, 0, r1 - r0 + w * 0.3);
        g.addColorStop(0, grey(ring.h0));
        g.addColorStop(0.65, grey(ring.h1 - 0.06));
        g.addColorStop(0.9, grey(ring.h1));
        g.addColorStop(1, grey(ring.h1 - 0.1));
        ctx.fillStyle = g;
        ctx.fill(p);
        ctx.lineWidth = Math.max(1.5, r * 0.012);
        ctx.strokeStyle = grey(ring.h1 + 0.04);
        ctx.stroke(p);
        ctx.restore();
      }
    });
    // bud / stamens
    for (let i = 0; i < 9; i++) {
      const a = R(0, Math.PI * 2);
      const d = R(0, r * 0.12);
      berry(x + Math.cos(a) * d, y + Math.sin(a) * d, r * R(0.05, 0.08), h);
    }
  }

  // Citrus slice: rind ring + domed segments. A nod to bergamot.
  function citrus(x, y, r, h) {
    const rind = new Path2D();
    rind.arc(x, y, r * 0.93, 0, Math.PI * 2);
    roundStroke(rind, r * 0.13, h - 0.08);
    const n = 10;
    const rot = R(0, Math.PI);
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2 + 0.06;
      const a1 = rot + ((i + 1) / n) * Math.PI * 2 - 0.06;
      const am = (a0 + a1) / 2;
      const p = new Path2D();
      p.moveTo(x + Math.cos(am) * r * 0.1, y + Math.sin(am) * r * 0.1);
      p.arc(x, y, r * 0.8, a0, a1);
      p.closePath();
      const cx = x + Math.cos(am) * r * 0.5;
      const cy = y + Math.sin(am) * r * 0.5;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.42);
      g.addColorStop(0, grey(h - 0.1));
      g.addColorStop(1, grey(FLAT + 0.06));
      ctx.fillStyle = g;
      ctx.fill(p);
    }
    berry(x, y, r * 0.08, h - 0.15);
  }

  // Medallion with the monogram "LI" (Lorem Ipsum) — raised letters.
  function medallion(x, y, r, h) {
    const disc = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    disc.addColorStop(0, grey(FLAT + 0.14));
    disc.addColorStop(0.85, grey(FLAT + 0.2));
    disc.addColorStop(1, grey(FLAT + 0.05));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const rim = new Path2D();
    rim.arc(x, y, r * 0.92, 0, Math.PI * 2);
    roundStroke(rim, r * 0.07, h - 0.1);
    const inner = new Path2D();
    inner.arc(x, y, r * 0.8, 0, Math.PI * 2);
    ctx.lineWidth = r * 0.012;
    ctx.strokeStyle = grey(FLAT + 0.32);
    ctx.stroke(inner);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `400 ${Math.round(r * 0.9)}px "Cormorant Garamond", serif`;
    // stacked fills = rounded letter profile after blur
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = grey(FLAT + 0.32 + i * 0.12);
      ctx.lineWidth = r * 0.03 * (3 - i);
      ctx.strokeStyle = ctx.fillStyle;
      if (i < 3) ctx.strokeText("LI", x, y + r * 0.04);
      ctx.fillText("LI", x, y + r * 0.04);
    }
  }

  // Carved inscription band with raised fillets above and below.
  function inscription(y, text, h) {
    const x0 = S * 0.06;
    const x1 = S * 0.94;
    for (const dy of [-S * 0.034, S * 0.034]) {
      const p = new Path2D();
      p.moveTo(x0, y + dy);
      p.lineTo(x1, y + dy);
      roundStroke(p, S * 0.006, h);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // shrink the type until the line fits between the fillets
    let size = S * 0.036;
    for (let i = 0; i < 6; i++) {
      ctx.font = `500 ${Math.round(size)}px "Cormorant Garamond", serif`;
      if ("letterSpacing" in ctx) ctx.letterSpacing = `${Math.round(size * 0.33)}px`;
      const w = ctx.measureText(text).width;
      if (w <= (x1 - x0) * 0.94) break;
      size *= ((x1 - x0) * 0.94) / w;
    }
    // incised: deepest in the middle of each stroke
    ctx.lineWidth = S * 0.004;
    ctx.strokeStyle = grey(FLAT - 0.07);
    ctx.strokeText(text, S / 2, y + S * 0.002);
    ctx.fillStyle = grey(0.0);
    ctx.fillText(text, S / 2, y + S * 0.002);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  }

  // Draw a shape on a scratch canvas so parts can be cut away, then stamp it.
  function cutout(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w);
    c.height = Math.ceil(h);
    draw(c.getContext("2d"));
    return c;
  }

  // Crescent moon: a domed disc with an offset disc cut out of it.
  function moon(x, y, r, h) {
    const c = cutout(r * 2.2, r * 2.2, (g) => {
      const cx = r * 1.1;
      const grad = g.createRadialGradient(cx - r * 0.35, cx, 0, cx, cx, r);
      grad.addColorStop(0, grey(h));
      grad.addColorStop(0.75, grey(h - 0.2));
      grad.addColorStop(1, grey(FLAT + 0.05));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cx, r, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.arc(cx + r * 0.42, cx - r * 0.12, r * 0.86, 0, Math.PI * 2);
      g.fill();
    });
    ctx.drawImage(c, x - r * 1.1, y - r * 1.1);
  }

  // Four-pointed sparkle.
  function sparkle(x, y, r, h) {
    const p = new Path2D();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const b = a + Math.PI / 4;
      const tip = [x + Math.cos(a) * r, y + Math.sin(a) * r];
      if (i === 0) p.moveTo(...tip);
      else p.lineTo(...tip);
      p.quadraticCurveTo(x + Math.cos(b) * r * 0.12, y + Math.sin(b) * r * 0.12, x + Math.cos(a + Math.PI / 2) * r, y + Math.sin(a + Math.PI / 2) * r);
    }
    p.closePath();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, grey(h));
    g.addColorStop(1, grey(FLAT + 0.04));
    ctx.fillStyle = g;
    ctx.fill(p);
  }

  // Bearded iris: drooping falls, upright standards, stem and sword leaves.
  function iris(x, y, s, h) {
    const stem = new Path2D();
    stem.moveTo(x, y + s * 0.1);
    stem.quadraticCurveTo(x + s * 0.08, y + s * 0.9, x - s * 0.02, y + s * 1.7);
    roundStroke(stem, s * 0.07, h - 0.2);
    leaf(x - s * 0.02, y + s * 1.7, s * 1.25, s * 0.09, -Math.PI / 2 - 0.32, h - 0.18, -0.04);
    leaf(x - s * 0.02, y + s * 1.7, s * 1.0, s * 0.08, -Math.PI / 2 + 0.36, h - 0.2, 0.05);
    leaf(x - s * 0.02, y + s * 1.7, s * 0.7, s * 0.07, -Math.PI / 2 - 0.75, h - 0.24, -0.06);
    // falls
    leaf(x, y, s * 0.62, s * 0.24, Math.PI / 2 + 0.05, h - 0.12, 0.08);
    leaf(x, y, s * 0.6, s * 0.22, 0.35, h - 0.1, 0.12);
    leaf(x, y, s * 0.6, s * 0.22, Math.PI - 0.35, h - 0.1, -0.12);
    // standards
    leaf(x, y, s * 0.55, s * 0.17, -Math.PI / 2, h, 0.02);
    leaf(x, y, s * 0.5, s * 0.15, -Math.PI / 2 - 0.5, h - 0.04, -0.05);
    leaf(x, y, s * 0.5, s * 0.15, -Math.PI / 2 + 0.5, h - 0.04, 0.05);
    berry(x, y, s * 0.07, h);
  }

  // Fern frond: a curved rachis with dense, shrinking pinnae.
  function fern(x0, y0, cx, cy, x1, y1, s, h) {
    const stem = new Path2D();
    stem.moveTo(x0, y0);
    stem.quadraticCurveTo(cx, cy, x1, y1);
    roundStroke(stem, s * 0.06, h - 0.15);
    const n = 22;
    for (let i = 0; i < n; i++) {
      const t = 0.05 + (i / n) * 0.93;
      const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
      const py = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
      const a = Math.atan2(2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy), 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx));
      const len = s * (1 - t * 0.75) * (0.55 + 0.45 * Math.sin(Math.min(1, t * 3) * Math.PI * 0.5));
      for (const side of [-1, 1]) leaf(px, py, len, len * 0.17, a + side * 1.0, h - 0.05, side * 0.04);
    }
  }

  // Perfume flacon in relief: rounded shoulders, bevelled edge, faceted stopper.
  function flacon(x, y, hgt, h) {
    const w = hgt * 0.62;
    const top = y - hgt * 0.5;
    const shoulder = top + hgt * 0.36;
    const bottom = y + hgt * 0.5;
    const neckW = w * 0.2;
    const body = new Path2D();
    body.moveTo(x - neckW, shoulder - hgt * 0.06);
    body.bezierCurveTo(x - w * 0.52, shoulder - hgt * 0.04, x - w * 0.52, shoulder + hgt * 0.05, x - w * 0.5, shoulder + hgt * 0.14);
    body.lineTo(x - w * 0.47, bottom - hgt * 0.06);
    body.quadraticCurveTo(x - w * 0.46, bottom, x - w * 0.38, bottom);
    body.lineTo(x + w * 0.38, bottom);
    body.quadraticCurveTo(x + w * 0.46, bottom, x + w * 0.47, bottom - hgt * 0.06);
    body.lineTo(x + w * 0.5, shoulder + hgt * 0.14);
    body.bezierCurveTo(x + w * 0.52, shoulder + hgt * 0.05, x + w * 0.52, shoulder - hgt * 0.04, x + neckW, shoulder - hgt * 0.06);
    body.closePath();
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, grey(FLAT + 0.08));
    g.addColorStop(0.12, grey(h - 0.12));
    g.addColorStop(0.4, grey(h));
    g.addColorStop(0.88, grey(h - 0.16));
    g.addColorStop(1, grey(FLAT + 0.08));
    ctx.fillStyle = g;
    ctx.fill(body);
    ctx.lineWidth = hgt * 0.012;
    ctx.strokeStyle = grey(h + 0.04);
    ctx.stroke(body);
    // label plate, slightly sunk
    const lw = w * 0.5;
    const lh = hgt * 0.2;
    ctx.fillStyle = grey(h - 0.2);
    ctx.beginPath();
    ctx.roundRect(x - lw / 2, y + hgt * 0.08, lw, lh, hgt * 0.02);
    ctx.fill();
    ctx.lineWidth = hgt * 0.006;
    ctx.strokeStyle = grey(h - 0.05);
    ctx.stroke();
    // neck + stopper
    const neck = ctx.createLinearGradient(x - neckW, 0, x + neckW, 0);
    neck.addColorStop(0, grey(h - 0.25));
    neck.addColorStop(0.45, grey(h - 0.05));
    neck.addColorStop(1, grey(h - 0.28));
    ctx.fillStyle = neck;
    ctx.fillRect(x - neckW * 0.8, top + hgt * 0.2, neckW * 1.6, hgt * 0.12);
    const cap = new Path2D();
    cap.moveTo(x, top);
    cap.lineTo(x + w * 0.24, top + hgt * 0.1);
    cap.lineTo(x + w * 0.16, top + hgt * 0.21);
    cap.lineTo(x - w * 0.16, top + hgt * 0.21);
    cap.lineTo(x - w * 0.24, top + hgt * 0.1);
    cap.closePath();
    const cg = ctx.createLinearGradient(x - w * 0.24, top, x + w * 0.24, top + hgt * 0.2);
    cg.addColorStop(0, grey(h - 0.04));
    cg.addColorStop(0.5, grey(h + 0.04));
    cg.addColorStop(1, grey(h - 0.2));
    ctx.fillStyle = cg;
    ctx.fill(cap);
    ctx.lineWidth = hgt * 0.006;
    ctx.strokeStyle = grey(h - 0.22);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + hgt * 0.21);
    ctx.moveTo(x - w * 0.24, top + hgt * 0.1);
    ctx.lineTo(x + w * 0.24, top + hgt * 0.1);
    ctx.stroke();
  }

  // Bee: veined wings behind a striped, domed body.
  function bee(x, y, s, angle, h) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    leaf(-s * 0.05, -s * 0.1, s * 0.75, s * 0.2, -Math.PI / 2 - 0.45, h - 0.3, -0.05);
    leaf(s * 0.05, -s * 0.1, s * 0.75, s * 0.2, -Math.PI / 2 + 0.45, h - 0.3, 0.05);
    leaf(-s * 0.05, -s * 0.05, s * 0.5, s * 0.15, -Math.PI / 2 - 1.0, h - 0.34, -0.05);
    leaf(s * 0.05, -s * 0.05, s * 0.5, s * 0.15, -Math.PI / 2 + 1.0, h - 0.34, 0.05);
    const g = ctx.createRadialGradient(-s * 0.06, -s * 0.05, 0, 0, s * 0.12, s * 0.45);
    g.addColorStop(0, grey(h));
    g.addColorStop(0.8, grey(h - 0.2));
    g.addColorStop(1, grey(FLAT + 0.06));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, s * 0.18, s * 0.17, s * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = s * 0.035;
    ctx.strokeStyle = grey(h - 0.28);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(0, s * (0.1 + i * 0.13), s * 0.16, s * 0.05, 0, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }
    berry(0, -s * 0.24, s * 0.12, h - 0.05);
    ctx.lineWidth = s * 0.025;
    ctx.strokeStyle = grey(h - 0.2);
    for (const sd of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sd * s * 0.04, -s * 0.33);
      ctx.quadraticCurveTo(sd * s * 0.1, -s * 0.5, sd * s * 0.2, -s * 0.52);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Scallop shell: radiating ribs inside a scalloped rim, with hinge ears.
  function shell(x, y, r, angle, h) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const n = 11;
    const spread = 1.25;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 - spread + (i / (n - 1)) * spread * 2;
      const mid = 1 - Math.abs(i / (n - 1) - 0.5) * 0.5;
      leaf(0, 0, r * (0.9 + 0.1 * mid), r * 0.15, a, h - 0.08 * (1 - mid));
    }
    for (const sd of [-1, 1]) {
      ctx.fillStyle = grey(h - 0.22);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(sd * r * 0.32, r * 0.02);
      ctx.lineTo(sd * r * 0.28, -r * 0.16);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Hummingbird in profile: domed body, feathered wing and tail, long beak.
  function bird(x, y, s, flip, h) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(flip, 1);
    // tail
    for (let i = 0; i < 4; i++) leaf(-s * 0.35, s * 0.18, s * 0.55, s * 0.09, Math.PI * 0.82 + i * 0.09, h - 0.15);
    // body
    const g = ctx.createRadialGradient(-s * 0.05, -s * 0.05, 0, 0, 0, s * 0.42);
    g.addColorStop(0, grey(h));
    g.addColorStop(0.75, grey(h - 0.18));
    g.addColorStop(1, grey(FLAT + 0.05));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.42, s * 0.2, -0.45, 0, Math.PI * 2);
    ctx.fill();
    // head + beak
    berry(s * 0.34, -s * 0.24, s * 0.14, h);
    const beak = new Path2D();
    beak.moveTo(s * 0.45, -s * 0.27);
    beak.lineTo(s * 0.98, -s * 0.38);
    roundStroke(beak, s * 0.035, h - 0.12);
    ctx.fillStyle = grey(h - 0.32);
    ctx.beginPath();
    ctx.arc(s * 0.38, -s * 0.27, s * 0.025, 0, Math.PI * 2);
    ctx.fill();
    // wing: a fan of feathers sweeping up and back
    for (let i = 0; i < 7; i++) {
      leaf(s * 0.02, -s * 0.06, s * (0.95 - i * 0.07), s * 0.11, -Math.PI * 0.62 - i * 0.1, h - 0.02 - i * 0.02, -0.03);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- composition
  // Coordinates are fractions of the tile. The top ~0.55 of the tile is what the
  // hero shows, so the wreath sits there, to the right of the headline.

  const mx = 0.72 * S;
  const my = 0.27 * S;
  const mr = 0.085 * S;

  tiled(() => {
    // wreath around the medallion
    laurel(mx - mr * 0.25, my + mr * 1.75, mx - mr * 2.1, my + mr * 0.6, mx - mr * 0.7, my - mr * 1.7, S * 0.05, 0.86, { side: -1 });
    laurel(mx + mr * 0.25, my + mr * 1.75, mx + mr * 2.1, my + mr * 0.6, mx + mr * 0.7, my - mr * 1.7, S * 0.05, 0.86, { side: 1 });
    medallion(mx, my, mr, 0.95);
    // ribbon knot at the base of the wreath
    berry(mx, my + mr * 1.78, S * 0.012, 0.8);

    // flowing branches
    laurel(0.02 * S, 0.47 * S, 0.2 * S, 0.36 * S, 0.4 * S, 0.43 * S, S * 0.045, 0.82);
    laurel(0.98 * S, 0.62 * S, 0.84 * S, 0.7 * S, 0.66 * S, 0.66 * S, S * 0.042, 0.8);
    laurel(0.06 * S, 0.8 * S, 0.2 * S, 0.7 * S, 0.34 * S, 0.76 * S, S * 0.04, 0.78);
    laurel(0.58 * S, 0.06 * S, 0.5 * S, -0.02 * S, 0.4 * S, 0.04 * S, S * 0.038, 0.78);

    // rosettes
    rosette(0.92 * S, 0.1 * S, 0.06 * S, 0.95);
    rosette(0.44 * S, 0.68 * S, 0.075 * S, 0.97);
    rosette(0.86 * S, 0.78 * S, 0.06 * S, 0.94);
    rosette(0.1 * S, 0.6 * S, 0.05 * S, 0.92);
    rosette(0.47 * S, 0.24 * S, 0.042 * S, 0.9);

    // citrus slices
    citrus(0.3 * S, 0.2 * S, 0.048 * S, 0.88);
    citrus(0.64 * S, 0.8 * S, 0.044 * S, 0.86);
    citrus(0.95 * S, 0.4 * S, 0.034 * S, 0.84);

    // botanicals, objects and creatures in the gaps
    iris(0.17 * S, 0.05 * S, 0.075 * S, 0.94);
    iris(0.3 * S, 0.0 * S, 0.05 * S, 0.9);
    bird(0.84 * S, 0.47 * S, 0.05 * S, -1, 0.9);
    shell(0.53 * S, 0.79 * S, 0.036 * S, -0.3, 0.88);
    fern(0.2 * S, 0.62 * S, 0.3 * S, 0.47 * S, 0.47 * S, 0.5 * S, S * 0.03, 0.82);
    flacon(0.575 * S, 0.53 * S, 0.15 * S, 0.93);
    bird(0.3 * S, 0.34 * S, 0.065 * S, 1, 0.92);
    bee(0.62 * S, 0.15 * S, 0.035 * S, 0.5, 0.9);
    bee(0.88 * S, 0.57 * S, 0.03 * S, -0.7, 0.88);
    bee(0.2 * S, 0.97 * S, 0.03 * S, 1.9, 0.88);
    shell(0.74 * S, 0.62 * S, 0.042 * S, 0.25, 0.9);
    shell(0.9 * S, 0.27 * S, 0.034 * S, -0.5, 0.86);
    moon(0.06 * S, 0.3 * S, 0.04 * S, 0.9);
    rosette(0.33 * S, 0.62 * S, 0.035 * S, 0.88);
    iris(0.04 * S, 0.06 * S + S * 0.0, 0.035 * S, 0.86);
    fern(0.98 * S, 0.99 * S, 0.84 * S, 0.94 * S, 0.7 * S, 0.99 * S, S * 0.022, 0.8);

    inscription(0.9 * S, "ODOR · MEMORIA · LVX · TEMPVS · AETERNVM", FLAT + 0.22);

    // scattered buds and sparkles
    for (let i = 0; i < 34; i++) {
      const bx = R(0.02, 0.98) * S;
      const by = R(0, 1) * S;
      if (Math.abs(by - 0.9 * S) < 0.06 * S) continue;
      if (rand() < 0.4) sparkle(bx, by, R(0.008, 0.016) * S, R(0.6, 0.8));
      else berry(bx, by, R(0.004, 0.009) * S, R(0.5, 0.7));
    }
  });

  return canvas;
}
