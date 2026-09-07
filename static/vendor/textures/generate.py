#!/usr/bin/env python3
"""Generate the drafting surface's texture tiles.

RUN BY HAND, NEVER BY THE APP. The tiles beside this file are what ships;
this script is here so they can be reproduced, adjusted and argued with
rather than being five opaque binaries. It is not a build step (CLAUDE.md
hard rule 1) -- nothing in the app invokes it, and the app runs fine with
this file deleted.

    venv/bin/python static/vendor/textures/generate.py

WHY RASTERS AT ALL, when drafting.css already had procedural feTurbulence.
Turbulence is band-limited Perlin: every octave is the same kind of wiggle at
a different scale, so its histogram is symmetric and its features are round.
Paper is neither. A sheet of cartridge has long cellulose FIBRES lying in a
direction, a slow cloudiness from how the pulp settled, and a heavy tail of
dark flecks -- three things a sum of Perlin octaves cannot produce, and the
three things the eye uses to recognise paper. Same for a graphite swatch:
the particles sit on the peaks of the tooth, so their distribution inherits
the paper's fibre, not a Gaussian.

WHY GENERATED RATHER THAN SCANNED. A scan is more authentic still, and if one
is ever made these files are the thing to replace. Generated wins on the one
property a scan cannot have for free: these tiles are seamless by
construction. Every field below is built in the Fourier domain on a periodic
lattice, so the tile wraps exactly -- there is no seam to retouch and no
visible repeat beyond the one the eye finds in any 512px tile.

Each tile is written PNG first and converted with sips where JPEG is enough
(no alpha, and a photographic field is exactly what JPEG is good at).
"""

import struct
import subprocess
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
N = 512  # tile edge. Power of two, and a multiple of JPEG's 8px block, so
         # the wrap point never lands mid-block and pick up a ringing seam.


# --- fields ----------------------------------------------------------------

def _spectrum(n, rng):
    """White noise in the Fourier domain, on a periodic lattice.

    Everything below is a filter applied to this. Building the field in
    frequency space rather than by interpolating a lattice is what makes the
    result seamless: an inverse FFT of a periodic spectrum IS periodic.
    """
    return np.fft.fft2(rng.standard_normal((n, n)))


def _radii(n):
    """Cycles-per-tile for each frequency bin, and the unsigned axis grids."""
    f = np.fft.fftfreq(n) * n
    fy, fx = np.meshgrid(f, f, indexing="ij")
    r = np.sqrt(fx ** 2 + fy ** 2)
    r[0, 0] = 1.0  # DC: filtered out below, never divided by
    return r, fx, fy


def _normalise(a, lo=0.0, hi=1.0):
    a = a - a.min()
    if a.max() > 0:
        a = a / a.max()
    return a * (hi - lo) + lo


def pink(n, rng, beta=1.6, lowcut=1.5):
    """1/f^beta noise -- the slow cloudiness of how the pulp settled."""
    r, _, _ = _radii(n)
    amp = np.where(r >= lowcut, r ** -beta, 0.0)
    return _normalise(np.real(np.fft.ifft2(_spectrum(n, rng) * amp)))


def fibre(n, rng, angle_deg, length=34.0, width=1.15, density=0.9):
    """Cellulose fibres: noise stretched hard along one direction.

    An anisotropic gaussian in frequency space -- narrow across the fibre,
    wide along it -- turns round Perlin blobs into long thin strands. Three
    of these at different angles is what separates paper from static.
    """
    _, fx, fy = _radii(n)
    t = np.deg2rad(angle_deg)
    along = fx * np.cos(t) + fy * np.sin(t)
    across = -fx * np.sin(t) + fy * np.cos(t)
    amp = np.exp(-((along * length / n) ** 2) - ((across * width / n) ** 2) * 0.0004)
    amp *= np.where(np.sqrt(fx ** 2 + fy ** 2) >= 2.0, 1.0, 0.0)
    f = np.real(np.fft.ifft2(_spectrum(n, rng) * amp))
    return _normalise(f) * density


def specks(n, rng, count, size=1.7, gain=1.0):
    """The heavy tail: flecks of shive, dust, a silver grain on a plate.

    Placed as points and blurred by a small gaussian in frequency space,
    which keeps them periodic. Their *amplitudes* are drawn from a Pareto,
    because the thing Perlin cannot do is produce the occasional speck that
    is much darker than everything around it.
    """
    pts = np.zeros((n, n))
    ys = rng.integers(0, n, count)
    xs = rng.integers(0, n, count)
    np.add.at(pts, (ys, xs), rng.pareto(2.4, count) + 0.25)
    r, _, _ = _radii(n)
    blur = np.exp(-0.5 * (r * size / n * 2 * np.pi) ** 2)
    out = np.real(np.fft.ifft2(np.fft.fft2(pts) * blur))
    return _normalise(np.clip(out, 0, np.percentile(out, 99.85))) * gain


# --- writers ---------------------------------------------------------------

def _quantise_alpha(rgba, levels=24):
    """Round the alpha channel onto `levels` steps before writing.

    All the entropy in a single-ink tile is in its alpha, and PNG's filters
    have nothing to predict from pure noise -- so a full 8-bit alpha costs
    three or four times what the drawing needs. At the opacities these run
    at (nothing over 0.72, most of the field under 0.2) a 24-step alpha is
    indistinguishable and compresses to a third of the size.
    """
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    a = np.round(a * (levels - 1)) / (levels - 1)
    rgba[:, :, 3] = np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return rgba


def _png(path, planes):
    """Minimal PNG writer. planes is (h, w, c) uint8, c in (1, 2, 4)."""
    h, w, c = planes.shape
    colour = {1: 0, 2: 4, 4: 6}[c]
    raw = b"".join(b"\x00" + planes[y].tobytes() for y in range(h))
    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, colour, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _to_jpeg(png_path, quality):
    jpg = png_path.with_suffix(".jpg")
    subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(quality),
         str(png_path), "--out", str(jpg)],
        check=True, capture_output=True)
    png_path.unlink()
    return jpg


# --- the tiles -------------------------------------------------------------

def paper_tooth():
    """The light sheet. Multiplied over the page, so 255 is 'no change'.

    Kept in a narrow band near white: this has to be felt and not seen. The
    range is what stops it reading as a photograph of paper laid over a UI.
    """
    rng = np.random.default_rng(1771)
    cloud = pink(N, rng, beta=1.7)
    grain = pink(N, rng, beta=0.35, lowcut=6.0)
    fibres = (fibre(N, rng, 8, length=40) * 0.55
              + fibre(N, rng, -74, length=30) * 0.35
              + fibre(N, rng, 41, length=52) * 0.30)
    flecks = specks(N, rng, 190, size=1.5)

    f = (0.30 * cloud + 0.34 * grain + 0.30 * _normalise(fibres) + 0.16 * flecks)
    f = _normalise(f)
    # 214..255: at most a 16% darkening anywhere on the sheet.
    img = np.clip(255 - f * 41, 0, 255).astype(np.uint8)
    p = HERE / "paper-tooth.png"
    _png(p, img[:, :, None])
    return _to_jpeg(p, 62)


def plate_tooth():
    """The dark plate. Screened over the ground, so 0 is 'no change'.

    NOT the paper tile inverted -- that is a photographic negative, and it is
    the thing dark mode here exists to avoid. A glass plate has no fibre at
    all; what it has is emulsion grain, a slow development mottle, and the
    occasional bright silver speck. So: no fibre layer, a finer grain, and a
    much longer tail on the specks.
    """
    rng = np.random.default_rng(4409)
    mottle = pink(N, rng, beta=2.1)
    emulsion = pink(N, rng, beta=0.2, lowcut=9.0)
    silver = specks(N, rng, 300, size=1.15, gain=1.25)

    f = _normalise(0.34 * mottle + 0.44 * emulsion + 0.30 * silver)
    # 0..58: at most a 23% lift anywhere on the plate.
    img = np.clip(f * 58, 0, 255).astype(np.uint8)
    p = HERE / "plate-tooth.png"
    _png(p, img[:, :, None])
    return _to_jpeg(p, 66)


def graphite_tooth(name, ink, lo, hi, seed):
    """A graphite swatch: particles sitting on the peaks of the tooth.

    This is the density that replaces a flat tone. The paper field is
    generated FIRST and the graphite is laid on its peaks, which is why the
    speckle has the paper's fibre in it rather than being independent noise
    -- a pencil dragged across a sheet only touches what stands up.

    Written with the ink baked in, one tile per theme, for the same reason
    every SVG raster in drafting.css is: a background-image cannot be
    recoloured from a custom property.
    """
    rng = np.random.default_rng(seed)
    # lowcut is doing the important work here: below about 5 cycles per tile
    # the field stops being tooth and starts being cloud, and a cloud spread
    # over a whole working band reads as a stain rather than as an even tone.
    tooth = _normalise(0.58 * pink(N, rng, beta=0.95, lowcut=5.0)
                       + 0.42 * _normalise(fibre(N, rng, 15, length=22)
                                           + fibre(N, rng, -60, length=18)))
    bite = _normalise(pink(N, rng, beta=0.25, lowcut=11.0))
    # Multiplying the two is what makes it sparse: the pencil deposits only
    # where a high tooth peak meets a high bite, so most of the field is bare
    # paper and the particles that survive are at full strength.
    field = np.clip((tooth * 0.62 + bite * 0.55) - 0.665, 0, None)
    field = _normalise(field) ** 1.35
    alpha = np.clip(field * (hi - lo) + lo * (field > 0.02), 0, 1)

    rgba = np.zeros((N, N, 4), dtype=np.uint8)
    rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2] = ink
    rgba[:, :, 3] = (alpha * 255).astype(np.uint8)
    p = HERE / name
    _png(p, _quantise_alpha(rgba))
    return p


def wash_bleed():
    """A stain, as an alpha mask rather than a coloured tile.

    One file serves both themes and every colour the system washes in,
    because the tile carries the SHAPE and the page supplies the ink through
    a custom property. Three things make it read as a wash and not as a
    blurred rectangle: the boundary is ragged at two scales, the pigment
    POOLS at that boundary (the rim is denser than the middle, which is what
    a drying edge does), and the interior granulates.
    """
    rng = np.random.default_rng(90210)
    w, h = 256, 160
    ys, xs = np.mgrid[0:h, 0:w]
    # Distance to the nearest edge, as a 0..1 field -- the stain's body.
    d = np.minimum.reduce([xs / w, (w - 1 - xs) / w, ys / h, (h - 1 - ys) / h]) * 7.5

    coarse = _normalise(pink(w, rng, beta=2.3)[:h, :w]) - 0.5
    fine = _normalise(pink(w, rng, beta=0.9, lowcut=5.0)[:h, :w]) - 0.5
    edge = np.clip(d + coarse * 0.30 + fine * 0.13, 0, 1)

    body = np.clip(edge * 5.0, 0, 1) ** 0.62
    # The rim: a band just inside the boundary, held back a little from the
    # very edge so the pooling sits IN the stain rather than haloing it.
    rim = np.exp(-((edge - 0.11) / 0.07) ** 2) * 0.40
    granulation = (_normalise(pink(w, rng, beta=0.55, lowcut=8.0)[:h, :w]) - 0.5) * 0.30

    a = np.clip((body * 0.78 + rim + granulation * body), 0, 1)
    a *= np.clip(edge * 14.0, 0, 1)  # nothing survives outside the boundary

    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = 255
    rgba[:, :, 3] = (a * 255).astype(np.uint8)
    p = HERE / "wash-bleed.png"
    _png(p, _quantise_alpha(rgba))
    return p


if __name__ == "__main__":
    made = [
        paper_tooth(),
        plate_tooth(),
        graphite_tooth("graphite-tooth-light.png", (34, 38, 44), 0.0, 0.44, 2255),
        graphite_tooth("graphite-tooth-dark.png", (188, 205, 220), 0.0, 0.36, 3311),
        wash_bleed(),
    ]
    total = 0
    for p in made:
        total += p.stat().st_size
        print(f"  {p.name:26s} {p.stat().st_size / 1024:7.1f} KB")
    print(f"  {'TOTAL':26s} {total / 1024:7.1f} KB")
