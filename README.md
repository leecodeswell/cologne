# Lorem Ipsum — Portfolium

A minimal portfolio site for luxury fragrance films. All copy is Latin placeholder text.

- **Bas-relief wall.** A plaster background in WebGL. At rest the wall is blank plaster. The cursor raises a soft, embossed-paper relief out of it, and the raised trail then sinks back. The relief is a refined, neoclassical garden built as real 3D geometry, in the manner of a Robert Adam ceiling or Wedgwood jasperware. Flowing S-curved sprays carry garden roses, peonies, magnolias, lilies and bearded irises above graded leaves and buds. There are also butterflies, bees, bergamot slices, a lemon, a faceted perfume flacon, a laurel wreath around the "LI" medallion, and a carved Roman inscription. About half the wall is left as quiet plaster. Every few seconds a small patch swells up on its own and sinks back, so the wall feels alive between cursor movements. While raised, motifs bloom in a staggered order, and petals and wings breathe gently.
- **Dark interlude.** Between the two films the wall turns to dark polished stone, and the text turns light. The switch happens while a film fills the screen, so it's never seen.
- **Film chapters.** Each video is pinned while you scroll. It grows from a framed card to full-screen, and the scroll position scrubs through the clip. Latin captions appear in sequence.
- **Glass ripple.** The same cursor trail refracts the films with a soft chromatic split.
- **Lens pass.** The films get a "photographed glass" finish: luma sharpening, bloom with warm halation, a filmic curve, lens fringing, fine grain, and a band of light that glides across the glass as you scroll.

## Run locally

The videos are fetched with `fetch()`, so open the site through a server, not `file://`:

```bash
node serve.mjs
```

Then visit http://localhost:5173. `serve.mjs` has no dependencies and supports range requests.

It deploys as-is to any static host (GitHub Pages, Netlify, Vercel). There is no build step.

## Structure

| Path | What it is |
| --- | --- |
| `index.html` | Markup and all placeholder copy |
| `css/style.css` | Layout, typography, tokens (colors at the top) |
| `js/main.js` | Preloader, smooth scroll (Lenis), scroll animations (GSAP ScrollTrigger), cursor, index previews |
| `js/gl/scene.js` | three.js renderer: flowmap, relief bake, video planes |
| `js/gl/framesource.js` | Decodes film frames with WebCodecs for frame-accurate scroll-scrubbing |
| `js/gl/sculpture.js` | Builds the relief as 3D geometry: motifs and composition (edit them here) |
| `js/gl/sculpture.worker.js` | Runs `sculpture.js` off the main thread |
| `js/gl/heightmap.js` | The lettering (monogram, inscription), drawn on a 2D canvas |
| `js/gl/shaders.js` | GLSL for the flowmap, relief bake passes, plaster lighting, and video refraction |
| `docs/relief-before-after.jpg` | Captures of the old and new relief |
| `assets/video/` | The two cinematic MP4s |

## How the cursor effect works

1. **Bake the relief once.** At load, the sculpture is rendered into a height map, and the lighting data for it is baked (see below).
2. **Paint the cursor trail.** A 256×256 flowmap is updated every frame, swapping between two buffers. The cursor stamps its velocity and a "lift" value into it, and every frame the old values fade by about 4.5%. The occasional small swellings stamp into it too, with noise-warped, irregular edges.
3. **Raise and light the relief.** The wall shader reads the lift under each pixel and scales the relief from a faint 1.5% up to full depth. It then lights the plaster for that exact depth: normals, ambient occlusion, a soft cast shadow, cavity shading, and highlights on convex rims.

## How the relief is made

The relief is real 3D geometry, rendered once into textures. Nothing is rasterised per frame except one full-screen pass.

1. **Model** (`sculpture.js`, in a worker). Every motif is built from a few parametric primitives:
   - a **blade** (petal, leaf or feather): a curved centerline with tilt, arch and tip curl, plus a cross-section with cup, midrib fold, twist, ruffled rim and veins;
   - tapered **tubes** (stems, vines, tendrils, stamens);
   - **ellipsoids** (buds, berries, bodies);
   - polar **discs** (medallion, citrus slices);
   - half **lathes** (the faceted flacon).

   The composition is placed by hand, like a plaster ceiling rather than a carpet: the medallion and wreath, the flacon, and seven sprays. Each spray is a tapered stem along an S-curve, with alternate leaves graded smaller toward the tips, buds on short side stems, and blooms lifted above their own collar of leaves (layers: stem < leaves < petals). About 40–45% of the wall carries relief, and the area behind the hero headline stays quiet. About 110k vertices are built in under 0.1 s, in a worker.
2. **Height pass.** An orthographic camera looks straight down at the sculpture. It renders height, a per-motif phase and a "sway" weight into a 4× MSAA float target. The depth test keeps the topmost surface, so overhanging petals hide what lies under them, which gives real undercuts. Three copies, at y −1, 0 and +1, make the tile wrap seamlessly. The canvas lettering (`heightmap.js`) is then added, and the result is lightly blurred.
3. **Lighting bake.** Three passes run once:
   - **slopes + curvature** at full resolution;
   - **horizon slopes in 8 directions** at half resolution;
   - **a soft shadow toward the light**, plus the wide-blurred cavity height, phase and sway.

   Extruding a relief by *k* multiplies every horizon slope by exactly *k*. So the wall shader can turn the stored slopes into ambient occlusion for any lift level, as `sin(atan(k·m))` averaged over the 8 directions. This is Immersive Garden's "lighting baked at several extrusion depths", made continuous and much cheaper to bake.
4. **Per frame** (`reliefFrag`): 4 relief texture reads, plus grain and the flowmap. Measured at about 0.5 ms of GPU time at 1440×810 on the dev machine. The whole GPU bake took about 250 ms there at 2048².

Phones, small screens and low-core/low-memory devices get a 1024² bake with 70% tessellation. On screens narrower than 760 px, the tile stays 760 px wide and shows its right-hand part (wreath and medallion), so the motifs keep their size.

## Rendering strategy: options considered

| Option | Depth & organic quality | Motif density | Per-frame cost | Load / bake | Risk |
| --- | --- | --- | --- | --- | --- |
| **a)** Better 2D canvas height map | Low. Canvas gradients can't express overlap, cupping, curl or undercuts. Everything reads as an emboss. | Medium. Each motif is hand-drawn code. | Same as before | ~100 ms | Low, but capped quality |
| **b)** Procedural 3D geometry → orthographic height pass | High. Real petals that cup, curl and overlap, true undercuts, leaves with midrib and twist | High. Primitives are reusable, so scattering hundreds is cheap. | Same as before (still one full-screen pass) | ~0.3 s CPU in a worker + 1 render | Medium (vertex budget, MSAA support) |
| **c)** SDF motifs, evaluated in a bake shader | High for blobby shapes; thin, curled petals and feathers are hard to express | Medium. Cost grows with every primitive, per pixel. | Same | Seconds at 2048² for a dense scene | High (long shaders, compile stalls on mobile) |
| **d)** Multi-level baked AO / shadow, blended by lift | Large gain: contact shadows and deep crevices at every lift level | n/a (lighting only) | +3 texture reads | +1 pass per level (or, here, one horizon bake) | Low |
| **e)** Displaced plane mesh per frame | Parallax only matters at grazing angles. This wall is seen head-on, so little gain. | n/a | Much higher (a dense mesh every frame) | none | Medium (aliasing, vertex cost on phones) |

**Chosen: b + d.** Real geometry (b) gives the cupped, layered, undercut forms and the density that a canvas map (a) can't. It's cheaper and more flexible than SDFs (c) for thin curled shapes. Baked horizons (d) give the studio-render depth: soft contact shadows and dark crevices. Storing horizon slopes instead of finished AO images makes the bake exact for every extrusion level, not just 6. Fragment-only shading is kept, rather than per-frame displacement (e), because the camera never tilts, so a displaced mesh would add cost without visible benefit.

## Tuning

- **Review the whole design:** open the site with `?relief=full` to hold the entire relief raised.
- **Composition:** the sprays and their blooms are listed in `buildSculpture()` in `js/gl/sculpture.js`, and `DEPTH_SCALE` sets how far everything stands off the wall.
- **Relief depth at rest / when revealed:** `uRest` and `uDepth` in `js/gl/scene.js`
- **Paper physics** (`js/gl/scene.js`):
  - `uBulge`: how far the sheet itself swells under the trail
  - `uPersp`: how strongly risen areas push outward from the screen centre (smaller = more perspective)
  - `uCrumple`: how much the sheet breaks into tilted facets while it bends
  - `uSnap`: how strongly the relief rises in five beats rather than smoothly
  - `uSmear`: how much the image stretches across a rising or sinking edge, so motifs melt in and out like immersive-g's single mesh
  - The total warp is capped at about 1% of the wall in `reliefFrag`.
- **Palette:** the wall tone is `uColor` in `js/gl/scene.js`, and the page tokens are at the top of `css/style.css`. Both use immersive-g.com's neutral whites: `#e8e8e8` page, `#030303` ink, and a wall of about `#e0e0e0` at rest.
- **Shadow depth:** `uAO` (ambient occlusion strength) in `js/gl/scene.js`; cast-shadow and rim strength in `reliefFrag` in `js/gl/shaders.js`
- **"Alive" motion:** `uAlive` (breathing amplitude) in `js/gl/scene.js`; the staggered bloom is the `lift * 1.3 - phase * 0.3` line in `reliefFrag`
- **Sculpture height:** `DEPTH_SCALE` in `js/gl/sculpture.js`
- **Density and motifs:** `buildSculpture()` in `js/gl/sculpture.js`: the bloom count and `kinds` weights, the vine count, the `quiet()` zone behind the headline, the fill roll
- **Bake resolution / mobile tier:** `bakeSize` and `bakeDetail` in the `WallScene` constructor; `MIN_TILE` for the narrow-screen tile width
- **Trail size and fade:** `uFalloff` and `uDissipation` in the `Flowmap` class
- **Wall parallax:** `WALL_SPEED` in `js/gl/scene.js`
- **Length of each pinned film chapter:** `end: … * 2.2` in `setupFilms()` in `js/main.js`
- **Scroll smoothing:** `lerp` in the `Lenis` constructor in `js/main.js` (higher = snappier)

## How the films are scrubbed

`js/gl/framesource.js` reads the MP4 itself and decodes exactly the frame for the current scroll position with WebCodecs. It then draws that frame to a canvas, which WebGL uploads as the film's texture.

Seeking a `<video>` element isn't reliable for this: some browsers (desktop Chrome among them) stop presenting new frames for a video that isn't visibly on screen, and ours sits invisible under the canvas. That made the films freeze. Where WebCodecs isn't available, the site falls back to seeking the `<video>`.

## Videos for scroll-scrubbing

Scrubbing seeks the video on every frame, so the files need frequent keyframes. Clips from video generators usually have just one keyframe, so every seek re-decodes from the start. That's slow and choppy, especially near the end.

The files in `assets/video/` were re-encoded with a keyframe every 3 frames, at 20 Mbps H.264, keeping all 220 frames. If you swap in new footage, re-encode it the same way. For example, with ffmpeg:

```bash
ffmpeg -i input.mp4 -c:v libx264 -crf 16 -g 3 -keyint_min 3 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -an output.mp4
```

## Accessibility

With `prefers-reduced-motion`, there's no pinning or scrubbing. The films simply loop, and the relief stays at a fixed, readable depth with no breathing motion.
