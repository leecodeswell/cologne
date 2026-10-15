import { WallScene } from "./gl/scene.js";

const { gsap, ScrollTrigger, Lenis } = window;
const root = document.documentElement;
const body = document.body;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);
if (reduced) root.classList.add("reduced");

// If the animation libraries failed to load, show a plain, usable page.
if (!gsap || !ScrollTrigger) {
  root.classList.add("no-webgl", "reduced");
  document.querySelector(".loader")?.remove();
  document.querySelector(".gl")?.remove();
  body.classList.remove("is-loading");
  document.querySelectorAll("video[data-src]").forEach((v) => {
    v.src = v.dataset.src;
    v.loop = true;
    v.play().catch(() => {});
  });
  throw new Error("GSAP unavailable — static fallback");
}

gsap.registerPlugin(ScrollTrigger);

// ---------------------------------------------------------------------------
// WebGL wall
// ---------------------------------------------------------------------------
let scene = null;
try {
  scene = new WallScene(document.querySelector(".gl"), { reducedMotion: reduced });
} catch (err) {
  console.warn("WebGL unavailable, using DOM video.", err);
  root.classList.add("no-webgl");
  document.querySelector(".gl")?.remove();
}

// ---------------------------------------------------------------------------
// Smooth scroll
// ---------------------------------------------------------------------------
let lenis = null;
if (!reduced && Lenis) {
  lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  lenis.stop();
}
gsap.ticker.lagSmoothing(0);

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { duration: 1.2 });
    else target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  });
});

// ---------------------------------------------------------------------------
// Preload: fetch videos fully (so scrubbing never stalls), fonts, relief bake
// ---------------------------------------------------------------------------
async function preloadVideos(onProgress) {
  const videos = [...document.querySelectorAll("video[data-src]")];
  const paths = [...new Set(videos.map((v) => v.dataset.src))];
  const state = new Map(paths.map((p) => [p, { got: 0, total: 0 }]));
  const report = () => {
    let got = 0;
    let total = 0;
    state.forEach((s) => {
      got += s.got;
      total += s.total || 1e7;
    });
    onProgress(got / total);
  };

  const urls = {};
  await Promise.all(
    paths.map(async (path) => {
      try {
        const res = await fetch(path);
        if (!res.ok || !res.body) throw new Error(res.statusText);
        const s = state.get(path);
        s.total = Number(res.headers.get("content-length")) || 0;
        const reader = res.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          s.got += value.length;
          report();
        }
        urls[path] = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
      } catch {
        urls[path] = path; // e.g. opened from file:// — stream normally
      }
    })
  );

  await Promise.all(
    videos.map((v) => {
      v.src = urls[v.dataset.src];
      v.load();
      return new Promise((resolve) => {
        if (v.readyState >= 2) return resolve();
        v.addEventListener("loadeddata", resolve, { once: true });
        v.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    })
  );
}

const counter = document.querySelector("[data-count]");
const load = { target: 0, shown: 0 };
const updateCounter = () => {
  load.shown += (load.target - load.shown) * 0.1;
  counter.textContent = String(Math.round(load.shown * 100)).padStart(3, "0");
};
gsap.ticker.add(updateCounter);

async function boot() {
  const fonts = document.fonts
    ? Promise.all([
        document.fonts.load('400 100px "Cormorant Garamond"'),
        document.fonts.load('500 100px "Cormorant Garamond"'),
        document.fonts.load('300 16px "Jost"'),
      ]).catch(() => {})
    : Promise.resolve();

  await Promise.all([fonts, preloadVideos((p) => (load.target = p * 0.92))]);
  scene?.bakeRelief(); // needs the serif loaded for the inscription
  load.target = 1;
  await new Promise((resolve) => {
    const check = () => (load.shown > 0.995 ? (gsap.ticker.remove(check), resolve()) : null);
    gsap.ticker.add(check);
  });
  gsap.ticker.remove(updateCounter);
  counter.textContent = "100";

  setupFilms();
  if (reduced) {
    ScrollTrigger.create({
      trigger: ".interlude",
      start: "top 60%",
      end: "bottom 40%",
      onToggle: (self) => (interludeDark = self.isActive),
    });
  }
  setupWords();
  setupReveals();
  setupProgress();
  setupPreview();
  ScrollTrigger.refresh();
  start();
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const films = [];

gsap.ticker.add((_, deltaMs) => {
  for (const f of films) {
    const d = f.video.duration;
    if (!d || reduced) continue;
    const t = f.target * (d - 0.04);
    f.shown += (t - f.shown) * 0.35;
    if (f.gl) f.gl.uniforms.uProgress.value = f.shown / d;
    if (!f.video.seeking && Math.abs(f.video.currentTime - f.shown) > 0.012) {
      f.video.currentTime = f.shown;
    }
  }
  updateDark();
  if (scene) {
    scene.setScroll(window.scrollY);
    scene.render(deltaMs);
  }
});

// The wall is dark between the two films. The switch happens while a film
// fills the screen (first film fully grown → second film fully grown), so the
// change itself is never seen.
let isDark = false;
let interludeDark = false; // reduced-motion fallback, set by a ScrollTrigger
function updateDark() {
  const [a, b] = films;
  const dark = reduced ? interludeDark : Boolean(a && b && a.target > 0.4 && b.target < 0.36);
  if (dark === isDark) return;
  isDark = dark;
  root.classList.toggle("is-dark", dark);
  if (scene) scene.darkTarget = dark ? 1 : 0;
}

window.addEventListener("resize", () => scene?.resize());

// ---------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------
function start() {
  const tl = gsap.timeline();
  tl.to(".loader__mark", { autoAlpha: 0, y: -12, duration: 0.4, ease: "power2.in" })
    .to(".loader", { autoAlpha: 0, duration: 0.7, ease: "power2.inOut" }, "-=0.1")
    .add(() => {
      body.classList.remove("is-loading");
      lenis?.start();
      scene?.intro(gsap);
    }, "-=0.6");

  if (reduced) {
    tl.from("[data-intro], .chrome", { autoAlpha: 0, duration: 0.8, stagger: 0.05 }, "-=0.4");
    return;
  }
  tl.from(".hero__title .line > span", { yPercent: 115, duration: 1.3, ease: "expo.out", stagger: 0.09 }, "-=0.4")
    .from(".hero__eyebrow, .hero__lede, .hero__foot", { autoAlpha: 0, y: 20, duration: 1.0, ease: "expo.out", stagger: 0.07 }, "-=1.1")
    .from(".chrome, .progress", { autoAlpha: 0, duration: 0.9 }, "-=1.0");

  gsap.to(".hero__foot", {
    autoAlpha: 0,
    ease: "none",
    scrollTrigger: { start: 0, end: 260, scrub: true },
  });
}

// ---------------------------------------------------------------------------
// Film chapters: pinned; the frame grows from a card to full-bleed while the
// scroll position scrubs through the video, then captions play in sequence.
// ---------------------------------------------------------------------------
function setupFilms() {
  document.querySelectorAll(".film").forEach((section) => {
    const pin = section.querySelector(".film__pin");
    const frame = section.querySelector(".film__frame");
    const video = frame.querySelector("video");
    const head = section.querySelector(".film__head");
    const index = section.querySelector(".film__index");
    const caps = gsap.utils.toArray(section.querySelectorAll(".film__captions li"));
    const film = { video, target: 0, shown: 0 };
    films.push(film);

    if (scene) film.gl = scene.addFilm(frame, video);
    else video.style.opacity = 1;

    if (reduced) {
      video.loop = true;
      video.play().catch(() => {});
      return;
    }

    const state = { expand: 0 };
    const size = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w0 = Math.min(vw * (vw < 900 ? 0.86 : 0.46), vh * 0.56 * (16 / 9));
      const h0 = (w0 * 9) / 16;
      const e = state.expand;
      frame.style.width = `${w0 + (vw - w0) * e}px`;
      frame.style.height = `${h0 + (vh - h0) * e}px`;
    };

    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: pin,
        start: "top top",
        end: () => `+=${window.innerHeight * 2.2}`,
        pin: true,
        scrub: true,
        invalidateOnRefresh: true,
        onRefresh: size,
        onUpdate: (self) => (film.target = self.progress),
      },
    });

    tl.to(state, { expand: 1, duration: 0.34, ease: "power2.inOut", onUpdate: size }, 0.02)
      .to(head, { autoAlpha: 0, y: -40, duration: 0.14, ease: "power1.in" }, 0.06)
      .to(index, { autoAlpha: 1, duration: 0.08 }, 0.34);

    caps.forEach((cap, i) => {
      const at = 0.4 + i * 0.19;
      tl.fromTo(cap, { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0, duration: 0.07, ease: "power2.out" }, at);
      if (i < caps.length - 1) {
        tl.to(cap, { autoAlpha: 0, y: -28, duration: 0.06, ease: "power2.in" }, at + 0.13);
      }
    });
    tl.to({}, { duration: 0.01 }, 0.99);
    size();
  });
}

// Manifesto: words brighten as you read down.
function setupWords() {
  document.querySelectorAll("[data-words]").forEach((el) => {
    const words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map((w) => `<span class="w">${w}</span>`).join(" ");
    if (reduced) return;
    gsap.to(el.querySelectorAll(".w"), {
      opacity: 1,
      stagger: 0.1,
      ease: "none",
      scrollTrigger: { trigger: el, start: "top 78%", end: "bottom 42%", scrub: true },
    });
  });
}

function setupReveals() {
  if (reduced) return;
  gsap.utils.toArray("[data-reveal]").forEach((el) => {
    gsap.from(el, {
      autoAlpha: 0,
      y: 30,
      duration: 1.1,
      ease: "expo.out",
      scrollTrigger: { trigger: el, start: "top 90%" },
    });
  });
}

function setupProgress() {
  const bar = document.querySelector(".progress__bar");
  ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: (self) => (bar.style.transform = `scaleX(${self.progress})`),
  });
}

// ---------------------------------------------------------------------------
// Index list: a small looping film follows the cursor.
// ---------------------------------------------------------------------------
function setupPreview() {
  if (!finePointer) return;
  const preview = document.querySelector(".preview");
  const vids = [...preview.querySelectorAll("video")];
  const list = document.querySelector(".opera__list");
  const xTo = gsap.quickTo(preview, "x", { duration: 0.7, ease: "power3" });
  const yTo = gsap.quickTo(preview, "y", { duration: 0.7, ease: "power3" });

  list.addEventListener("pointermove", (e) => {
    xTo(e.clientX + 32);
    yTo(e.clientY - preview.offsetHeight / 2);
  });
  list.querySelectorAll("a").forEach((a) => {
    a.addEventListener("pointerenter", () => {
      const i = Number(a.dataset.preview) || 0;
      vids.forEach((v, j) => {
        v.classList.toggle("is-active", i === j);
        if (i === j) v.play().catch(() => {});
      });
    });
  });
  list.addEventListener("pointerenter", (e) => {
    gsap.set(preview, { x: e.clientX + 32, y: e.clientY - preview.offsetHeight / 2 });
    gsap.to(preview, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.8, ease: "expo.out" });
  });
  list.addEventListener("pointerleave", () => {
    gsap.to(preview, {
      clipPath: "inset(50% 50% 50% 50%)",
      duration: 0.6,
      ease: "expo.inOut",
      onComplete: () => vids.forEach((v) => v.pause()),
    });
  });
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
if (finePointer) {
  root.classList.add("has-cursor");
  const cursor = document.querySelector(".cursor");
  const xTo = gsap.quickTo(cursor, "x", { duration: 0.35, ease: "power3" });
  const yTo = gsap.quickTo(cursor, "y", { duration: 0.35, ease: "power3" });
  window.addEventListener("pointermove", (e) => {
    xTo(e.clientX);
    yTo(e.clientY);
  });
  document.addEventListener("pointerover", (e) => {
    const t = e.target.closest?.("[data-cursor]");
    const kind = t?.dataset.cursor;
    cursor.classList.toggle("is-link", kind === "link");
    cursor.classList.toggle("is-film", kind === "film");
  });
}

boot();
