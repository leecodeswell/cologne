// The lettering of the relief, drawn with the 2D canvas API: the raised "LI"
// monogram on the medallion and the carved Roman inscription. Everything else
// is real geometry (sculpture.js). This layer is added on top of the rendered
// sculpture: FLAT = no change, brighter = raised, darker = incised.

import { MEDALLION, BAND } from "./sculpture.js";

export const FLAT = 0.16;
// height (tile widths) of one unit of canvas grey above/below FLAT
export const CARVE_DEPTH = 0.024;

const grey = (v) => {
  const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c},${c},${c})`;
};

export function createCarveCanvas(size = 2048) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const S = size;

  ctx.fillStyle = grey(FLAT);
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // drawn at y - S, y and y + S so the layer tiles vertically
  for (const dy of [-S, 0, S]) {
    // Monogram: stacked fills give the letters a rounded profile after blur.
    const { x, y, r } = MEDALLION;
    const mx = x * S;
    const my = y * S + dy;
    const mr = r * S;
    ctx.font = `400 ${Math.round(mr * 0.9)}px "Cormorant Garamond", serif`;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = grey(FLAT + 0.12 + i * 0.09);
      ctx.lineWidth = mr * 0.03 * (3 - i);
      ctx.strokeStyle = ctx.fillStyle;
      if (i < 3) ctx.strokeText("LI", mx, my + mr * 0.04);
      ctx.fillText("LI", mx, my + mr * 0.04);
    }

    // Inscription, incised between the two fillets (which are geometry).
    const iy = BAND.y * S + dy;
    const x0 = S * 0.06;
    const x1 = S * 0.94;
    const text = "ODOR · MEMORIA · LVX · TEMPVS · AETERNVM";
    let fs = S * 0.036;
    for (let i = 0; i < 6; i++) {
      ctx.font = `500 ${Math.round(fs)}px "Cormorant Garamond", serif`;
      if ("letterSpacing" in ctx) ctx.letterSpacing = `${Math.round(fs * 0.33)}px`;
      const w = ctx.measureText(text).width;
      if (w <= (x1 - x0) * 0.94) break;
      fs *= ((x1 - x0) * 0.94) / w;
    }
    // V-cut: shallow at the stroke edges, deepest in the middle
    ctx.lineWidth = S * 0.004;
    ctx.strokeStyle = grey(FLAT - 0.07);
    ctx.strokeText(text, S / 2, iy + S * 0.002);
    ctx.fillStyle = grey(0);
    ctx.fillText(text, S / 2, iy + S * 0.002);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  }
  return canvas;
}
