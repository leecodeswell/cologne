// Frame-accurate scrubbing with WebCodecs.
//
// Scroll-scrubbing a <video> element relies on the browser presenting a new
// frame after each seek. Some browsers stop doing that for a video that is
// not visibly on screen (ours sits invisible under the WebGL canvas), so the
// film froze. Instead, this demuxes the MP4 ourselves, decodes exactly the
// frame that is asked for, and draws it to a canvas that WebGL uploads.
//
// Expects a single H.264 track without B-frames (decode order = display
// order) and frequent keyframes, as produced for this site (see README).

function readBoxes(view, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

const child = (view, box, type) => readBoxes(view, box.body, box.end).find((b) => b.type === type);

function parseMp4(buffer) {
  const view = new DataView(buffer);
  const moov = readBoxes(view, 0, buffer.byteLength).find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov box");

  // first video track
  const trak = readBoxes(view, moov.body, moov.end)
    .filter((b) => b.type === "trak")
    .find((t) => {
      const hdlr = child(view, child(view, t, "mdia"), "hdlr");
      return hdlr && String.fromCharCode(...new Uint8Array(buffer, hdlr.body + 8, 4)) === "vide";
    });
  if (!trak) throw new Error("no video track");
  const mdia = child(view, trak, "mdia");
  const mdhd = child(view, mdia, "mdhd");
  const v1 = view.getUint8(mdhd.body) === 1;
  const timescale = view.getUint32(mdhd.body + (v1 ? 20 : 12));
  const stbl = child(view, child(view, mdia, "minf"), "stbl");

  // codec description from the avc1 sample entry
  const stsd = child(view, stbl, "stsd");
  const entry = readBoxes(view, stsd.body + 8, stsd.end)[0];
  if (!entry || entry.type !== "avc1") throw new Error(`unsupported codec ${entry?.type}`);
  const width = view.getUint16(entry.body + 24);
  const height = view.getUint16(entry.body + 26);
  const avcC = readBoxes(view, entry.body + 78, entry.end).find((b) => b.type === "avcC");
  const description = new Uint8Array(buffer.slice(avcC.body, avcC.end));
  const hex = (n) => n.toString(16).padStart(2, "0");
  const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;

  // sample sizes
  const stsz = child(view, stbl, "stsz");
  const fixed = view.getUint32(stsz.body + 4);
  const count = view.getUint32(stsz.body + 8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || view.getUint32(stsz.body + 12 + i * 4);

  // chunk offsets
  const stco = child(view, stbl, "stco");
  const co64 = child(view, stbl, "co64");
  const chunkOffsets = [];
  if (stco) {
    const n = view.getUint32(stco.body + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(view.getUint32(stco.body + 8 + i * 4));
  } else {
    const n = view.getUint32(co64.body + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(Number(view.getBigUint64(co64.body + 8 + i * 8)));
  }

  // samples per chunk → absolute sample offsets
  const stsc = child(view, stbl, "stsc");
  const runs = [];
  const nRuns = view.getUint32(stsc.body + 4);
  for (let i = 0; i < nRuns; i++) {
    const o = stsc.body + 8 + i * 12;
    runs.push({ first: view.getUint32(o) - 1, perChunk: view.getUint32(o + 4) });
  }
  const offsets = new Array(count);
  let sample = 0;
  for (let c = 0; c < chunkOffsets.length && sample < count; c++) {
    let run = runs[0];
    for (const r of runs) if (r.first <= c) run = r;
    let off = chunkOffsets[c];
    for (let s = 0; s < run.perChunk && sample < count; s++) {
      offsets[sample] = off;
      off += sizes[sample++];
    }
  }

  // keyframes (all samples are sync samples if stss is absent)
  const stss = child(view, stbl, "stss");
  const isKey = new Uint8Array(count);
  if (stss) {
    const n = view.getUint32(stss.body + 4);
    for (let i = 0; i < n; i++) isKey[view.getUint32(stss.body + 8 + i * 4) - 1] = 1;
  } else {
    isKey.fill(1);
  }

  // total duration
  const stts = child(view, stbl, "stts");
  let ticks = 0;
  const nStts = view.getUint32(stts.body + 4);
  for (let i = 0; i < nStts; i++) {
    const o = stts.body + 8 + i * 8;
    ticks += view.getUint32(o) * view.getUint32(o + 4);
  }

  if (child(view, stbl, "ctts")) throw new Error("B-frames are not supported");
  return { codec, description, width, height, count, sizes, offsets, isKey, duration: ticks / timescale };
}

// Returns null when WebCodecs or the codec is unavailable (the caller then
// falls back to the <video> element).
export async function createFrameSource(buffer) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;
  let info;
  try {
    info = parseMp4(buffer);
  } catch (err) {
    console.warn("Frame source unavailable:", err);
    return null;
  }
  const config = {
    codec: info.codec,
    description: info.description,
    codedWidth: info.width,
    codedHeight: info.height,
    optimizeForLatency: true,
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;

  const bytes = new Uint8Array(buffer);
  const canvas = document.createElement("canvas");
  canvas.width = info.width;
  canvas.height = info.height;
  const ctx = canvas.getContext("2d", { alpha: false });

  let target = -1;
  const source = {
    canvas,
    width: info.width,
    height: info.height,
    frameCount: info.count,
    duration: info.duration,
    shown: -1,
    onFrame: null,
    failed: false,
    show,
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (frame.timestamp === target) {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        source.shown = target;
        source.onFrame?.();
      }
      frame.close();
    },
    error: (err) => {
      console.warn("Frame decode failed:", err);
      source.failed = true;
    },
  });
  decoder.configure(config);

  // Decode the keyframe at or before n, then forward to n (at most a couple
  // of frames with this site's encoding). Requests that arrive while busy
  // collapse into the newest one.
  let wanted = -1;
  let busy = false;
  async function show(n) {
    wanted = Math.max(0, Math.min(info.count - 1, Math.round(n)));
    if (busy || source.failed) return;
    busy = true;
    try {
      while (wanted !== source.shown && !source.failed) {
        const want = wanted;
        let k = want;
        while (k > 0 && !info.isKey[k]) k--;
        target = want;
        for (let i = k; i <= want; i++) {
          decoder.decode(
            new EncodedVideoChunk({
              type: i === k ? "key" : "delta",
              timestamp: i,
              data: bytes.subarray(info.offsets[i], info.offsets[i] + info.sizes[i]),
            })
          );
        }
        await decoder.flush();
        if (source.shown !== want) break; // decoder produced nothing; avoid spinning
      }
    } catch (err) {
      console.warn("Frame decode failed:", err);
      source.failed = true;
    } finally {
      busy = false;
    }
  }

  await show(0);
  return source.failed ? null : source;
}
