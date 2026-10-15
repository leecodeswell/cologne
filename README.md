# Lorem Ipsum — Portfolium

A minimal portfolio site for luxury fragrance films. All copy is Latin placeholder text.

- **Bas-relief wall.** A plaster background in WebGL. The cursor raises a carved relief out of the wall, and the raised trail then sinks back. The relief includes a laurel wreath and monogram, rosettes, irises, ferns, a perfume flacon, hummingbirds, bees, shells, a crescent moon, citrus slices and a Roman inscription. Random swellings and a "ghost cursor" keep the wall moving on its own.
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
| `js/gl/heightmap.js` | Draws the relief artwork procedurally (edit motifs/composition here) |
| `js/gl/shaders.js` | GLSL for the flowmap, blur, plaster lighting, and video refraction |
| `assets/video/` | The two cinematic MP4s |

## How the cursor effect works

1. **Paint the cursor trail.** `heightmap.js` draws the relief as a greyscale height map on a canvas. The GPU blurs it into float textures.
2. **Turn it into a mask.** A 256×256 flowmap is updated every frame, swapping between two buffers. The cursor stamps its velocity and a "lift" value into it, and every frame the old values fade by about 4.5%.
3. **Raise and light the relief.** The wall shader reads the lift under each pixel and scales the relief depth from a faint 3% up to full. It then lights the plaster from that depth: per-pixel normals, soft self-shadowing and cavity shading.

## Tuning

- **Relief depth at rest / when revealed:** `uRest` and `uDepth` in `js/gl/scene.js`
- **Trail size and fade:** `uFalloff` and `uDissipation` in the `Flowmap` class
- **Wall parallax:** `WALL_SPEED` in `js/gl/scene.js`
- **Length of each pinned film chapter:** `end: … * 2.2` in `setupFilms()` in `js/main.js`
- **Scroll smoothing:** `lerp` in the `Lenis` constructor in `js/main.js` (higher = snappier)

## Videos for scroll-scrubbing

Scrubbing seeks the video on every frame, so the files need frequent keyframes. Clips from video generators usually have just one keyframe, so every seek re-decodes from the start. That's slow and choppy, especially near the end.

The files in `assets/video/` were re-encoded with a keyframe every 3 frames, at 20 Mbps H.264, keeping all 220 frames. If you swap in new footage, re-encode it the same way. For example, with ffmpeg:

```bash
ffmpeg -i input.mp4 -c:v libx264 -crf 16 -g 3 -keyint_min 3 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -an output.mp4
```

## Accessibility

With `prefers-reduced-motion`, there's no pinning or scrubbing. The films simply loop, and the relief stays at a fixed, readable depth.
