# Vendored textures — the drafting surface

Five seamless tiles used by `static/drafting.css` (schedule surface only —
see CLAUDE.md hard rule 6). Nothing else in the app loads them.

| File | Size | What it is | How it is used |
|---|---|---|---|
| `paper-tooth.jpg` | 33 KB | Cartridge-paper tooth: pulp cloudiness, cellulose fibre, flecks | `.dr-grain`, multiplied over the light sheet |
| `plate-tooth.jpg` | 36 KB | Photographic-plate ground: emulsion grain, development mottle, silver specks | `.dr-grain`, screened over the dark plate |
| `graphite-tooth-light.png` | 31 KB | A graphite swatch on that tooth — sparse full-strength particles | `--dr-stipple`, the tonal field |
| `graphite-tooth-dark.png` | 44 KB | The same swatch re-inked for the plate | `--dr-stipple` in dark mode |
| `wash-bleed.png` | 16 KB | A laid wash: ragged deckle, pigment pooled at the rim, granulated interior | `--dr-wash-mask`, as a mask over a colour |
| | **160 KB** | | |

## Provenance

| | |
|---|---|
| Origin | **Generated**, by `generate.py` in this directory |
| Author | Written for this repository; no third-party material of any kind |
| Licence | None required — same licence as the rest of the repository |
| Made | 2026-09-07 |

**These are not scans.** A scan of real cartridge paper and a real graphite
swatch would be more authentic still, and if one is ever made these five
files are the thing to replace — the CSS reads them through custom properties
(`--dr-grain`, `--dr-stipple`, `--dr-wash-mask`) and cares about nothing but
their size and their seams. Two reasons it is generated for now: there is no
scanner in this loop, and a stock CC0 tile would put a licence to track and a
provenance to trust in the middle of a design system, for a texture nobody
will ever identify.

## Why rasters at all

`drafting.css` used to make every texture from `feTurbulence`, and the file
argued for it: no asset, no licence, seamless by construction, and
re-derived at whatever pixel density the display has. Those arguments still
hold. The one that beat them is that **turbulence is band-limited Perlin** —
every octave is the same wiggle at a different scale, so its histogram is
symmetric and its features are round. Paper is neither. A sheet has

* long cellulose **fibres** lying in a direction,
* a slow **cloudiness** from how the pulp settled,
* and a heavy tail of dark **flecks**,

and those three things are what the eye uses to recognise paper. None of them
is a sum of Perlin octaves, which is why the procedural sheet read as noise
over a UI rather than as a material. Same for graphite: the particles sit on
the peaks of the tooth, so their distribution inherits the paper's fibre.
`generate.py` builds each field in the Fourier domain — anisotropic filters
for fibre, `1/f^β` for cloudiness, a Pareto tail for flecks.

Turbulence keeps the jobs it is still better at: every **line** in the system
(the setting-out grid, the hatching, the density masks that break a faint
rule up) is still an SVG data URI, because those need exact ruled geometry at
retina resolution and a raster cannot give it.

## Seams

Seamless **by construction**, not by retouching: every field is an inverse
FFT of a periodic spectrum, and the inverse FFT of a periodic spectrum is
periodic. There is no seam to hide. 512px is a multiple of JPEG's 8px block,
so the wrap point never lands mid-block and picks up ringing.

## Size

JPEG where there is no alpha (a photographic field is what JPEG is for),
PNG where there is. The PNG alpha is quantised to 24 steps before writing —
all the entropy in a single-ink tile is in that one channel, PNG's filters
have nothing to predict from noise, and at these opacities 24 steps is
indistinguishable from 256 and compresses to a third of the size.

## Reproducing them

    venv/bin/python static/vendor/textures/generate.py

`generate.py` is **not a build step** (CLAUDE.md hard rule 1): nothing in the
app invokes it, the tiles beside it are what ships, and the app runs fine
with the script deleted. It is here so the tiles can be argued with and
adjusted rather than being five opaque binaries. It needs `numpy` (already in
the app's venv for CLIP) and macOS `sips` for the JPEG conversion.
