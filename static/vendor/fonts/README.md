# Vendored fonts

## IBM Plex Sans Condensed

| | |
|---|---|
| Files | `IBMPlexSansCondensed-Regular.ttf` (400), `IBMPlexSansCondensed-Medium.ttf` (500) |
| Version | 1.3 |
| Designer | Mike Abbink, Paul van der Laan, Pieter van Rosmalen — Bold Monday, for IBM |
| Copyright | © 2017 IBM Corp., with Reserved Font Name "Plex" |
| Licence | SIL Open Font License 1.1 — full text in `OFL.txt` beside these files |
| Source | `google/fonts`, `ofl/ibmplexsanscondensed/` (upstream: `IBM/plex`) |
| Retrieved | 2026-09-05 |

**Redistribution is permitted.** The OFL 1.1 explicitly allows the fonts to be
"bundled, embedded, redistributed and/or sold with any software" provided the
copyright notice and licence travel with them — which is why `OFL.txt` sits
next to the `.ttf` files rather than being linked. The only real conditions
are that the files are not sold on their own, and that a *modified* version
does not keep the Reserved Font Name "Plex". Neither applies here: the files
are byte-identical to upstream and are served as part of the app.

### Why this face

The schedule surface is drawn in a technical-drafting language (see
`static/drafting.css` and `design-references/`), which wants a condensed,
single-hand, engineering grotesque: legible at 9px uppercase and
letterspaced, with tabular figures for a measured hour axis. Plex is IBM's
corporate engineering face and its condensed cut is exactly that. Two weights
only, because in this system nothing is bold — things are *heavier*, one
step.

### How it is loaded

Two `@font-face` rules at the top of `static/drafting.css`, bound to
`--dr-face`. No build step, no CDN, no npm (CLAUDE.md hard rule 1), and
served from the app's own origin at `/vendor/fonts/…` like every other static
file.

It is deliberately **not** bound to `--display`, which is Ballet
(`static/fonts/`) and belongs to the archive.
