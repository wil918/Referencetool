"""Turn a saved colour palette into a project appearance style.

Two rules, applied in order:

1. Proportion. A palette entry's `weight` is the fraction of the source
   images it covered, so the heaviest entry becomes the background, the
   next-heaviest becomes the button surface, and a middle-weight entry
   becomes the accent -- the areas of the generated page mirror the areas of
   the palette it came from.

2. Contrast, which overrides proportion every time. Text and the accent are
   walked in CIELAB lightness -- hue and chroma held fixed -- until they clear
   a WCAG contrast-ratio threshold against whatever they sit on. A colour that
   already clears its threshold is used exactly as the palette gave it; only
   one that doesn't gets moved, and only as far as it has to.

Background and button surface are never contrast-checked against anything:
this app's own surfaces are the same colour as the page they sit on by
design (CLAUDE.md's neumorphic system -- depth comes from shadow, not fill),
so a button that lands close to the background colour is correct, not a bug.

Fonts are deliberately untouched -- nothing here sets primaryFont/
secondaryFont, so a generated style falls back to the project's or the
global defaults, exactly like a hand-made style that never touched them.

Determinism matters as much as the maths: colour.py's palette is already
ordered heaviest-first with ties broken by Lab value, and every choice below
either follows that fixed order or resolves ties by first occurrence in it,
so the same profile always produces the same style.
"""
import colour

# WCAG 2 thresholds. Body text is held to the stricter "never go below"
# figure rather than the lower large-text allowance, because a generated
# style has no way to know which widgets will set small type.
BODY_TEXT_MIN_CONTRAST = 4.5
SECONDARY_TEXT_MIN_CONTRAST = 3.0
BUTTON_TEXT_MIN_CONTRAST = 4.5
ACCENT_MIN_CONTRAST = 3.0

# How far each step of the lightness walk moves L (0-100). Small enough that
# the resulting colour lands close to the minimum contrast that satisfies the
# threshold rather than overshooting toward black/white by a visible margin.
_L_STEP = 0.5

# Display order and per-role WCAG target used by generate_style. `against`
# names which other resolved colour a role is checked against; None means
# proportion alone decides it, with no contrast rule at all.
_ROLES = ("bg", "button", "accent", "ink", "muted", "buttonInk")


def _relative_luminance(rgb):
    """WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white)."""
    def channel(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast_ratio(rgb_a, rgb_b):
    """WCAG contrast ratio between two sRGB colours, 1 (identical) to 21."""
    la, lb = _relative_luminance(rgb_a), _relative_luminance(rgb_b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def _to_hex(rgb):
    r, g, b = (max(0, min(255, int(round(v)))) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _lab_to_rgb(lab):
    return tuple(int(v) for v in colour.lab_to_rgb(lab))


def _proportion_indices(n):
    """Which palette indices (already weight-descending) feed background,
    button surface and accent.

    Background is always the heaviest entry and button the next-heaviest.
    Accent prefers a genuinely middle entry -- one that is neither of those
    two -- so it reads as a third distinct colour rather than a repeat of
    the button surface; with fewer than three entries there is nothing left
    to be "middle", so it falls back to the next-heaviest the same way
    button does. Nothing here needs to be more precise than "middle-ish":
    the contrast pass afterwards is what actually determines the accent's
    final colour, not this pick.
    """
    heavy = 0
    nxt = 1 if n > 1 else 0
    if n > 2:
        unused = [i for i in range(n) if i not in (heavy, nxt)]
        mid = unused[len(unused) // 2]
    else:
        mid = nxt
    return heavy, nxt, mid


def _best_contrast_entry(entries, against_rgb):
    """The palette entry with the most contrast against `against_rgb`.

    This is how text "is chosen for contrast" rather than proportion: the
    palette entry that already reads best against the surface it will sit
    on becomes the seed a text colour is walked from, so the walk (below)
    has to move it as little as possible. When every entry is close in
    lightness (a near-monochrome palette) this still picks a definite,
    deterministic entry -- ties broken by first occurrence in the
    already-deterministic palette order -- and the walk does the rest.
    """
    return max(entries, key=lambda e: contrast_ratio(tuple(e["rgb"]), against_rgb))


def _walk_lightness(seed_lab, against_rgb, threshold):
    """Move `seed_lab`'s L toward whichever of black/white contrasts more
    with `against_rgb`, keeping a/b (hue and chroma) fixed, until the
    result's contrast against `against_rgb` clears `threshold`.

    Always terminates with the threshold met (for every threshold used in
    this module, all <= 4.5): WCAG's own algebra guarantees
    contrast(black, x) * contrast(white, x) == 21 for any x, so if one of
    the two pure endpoints scores below sqrt(21) =~ 4.58 the other must score
    above it -- the walk simply never needs to reach the losing endpoint.
    """
    contrast_black = contrast_ratio((0, 0, 0), against_rgb)
    contrast_white = contrast_ratio((255, 255, 255), against_rgb)
    target_l = 100.0 if contrast_white >= contrast_black else 0.0
    step = _L_STEP if target_l > seed_lab[0] else -_L_STEP

    lab = [seed_lab[0], seed_lab[1], seed_lab[2]]
    rgb = _lab_to_rgb(lab)
    ratio = contrast_ratio(rgb, against_rgb)

    while ratio < threshold and lab[0] != target_l:
        lab[0] += step
        overshot = (step > 0 and lab[0] > target_l) or (step < 0 and lab[0] < target_l)
        if overshot:
            lab[0] = target_l
        rgb = _lab_to_rgb(lab)
        ratio = contrast_ratio(rgb, against_rgb)

    return rgb, ratio


def _resolve(seed_lab, against_rgb=None, threshold=None, against_label=None):
    """A role's final colour: `seed_lab` unchanged if it already clears
    `threshold` against `against_rgb` (or if there is no threshold at all --
    background and button surface are never contrast-checked), otherwise
    walked until it does.
    """
    seed_rgb = _lab_to_rgb(seed_lab)
    if against_rgb is None or threshold is None:
        return {
            "hex": _to_hex(seed_rgb), "source_hex": _to_hex(seed_rgb),
            "contrast": None, "threshold": None, "against": None, "adjusted": False,
        }

    seed_ratio = contrast_ratio(seed_rgb, against_rgb)
    if seed_ratio >= threshold:
        final_rgb, final_ratio, adjusted = seed_rgb, seed_ratio, False
    else:
        final_rgb, final_ratio = _walk_lightness(seed_lab, against_rgb, threshold)
        adjusted = True

    return {
        "hex": _to_hex(final_rgb),
        "source_hex": _to_hex(seed_rgb),
        "contrast": round(final_ratio, 2),
        "threshold": threshold,
        "against": against_label,
        "adjusted": adjusted,
    }


def generate_style(profile):
    """A project settings dict (and a report explaining it) generated from
    a colour.py profile -- see the module docstring for the two rules.

    Returns {"settings": {bg, button, accent, ink, muted, buttonInk},
    "report": {<same six keys>: {hex, source_hex, contrast, threshold,
    against, adjusted}}}. `settings` is exactly the shape project_settings
    and styles.settings already store (CLAUDE.md), minus fonts and content
    scale, which this never sets.
    """
    entries = profile.get("palette") or []
    if not entries:
        raise ValueError("profile has no palette to generate a style from")

    heavy_i, next_i, mid_i = _proportion_indices(len(entries))
    bg_rgb = _lab_to_rgb(entries[heavy_i]["lab"])
    button_rgb = _lab_to_rgb(entries[next_i]["lab"])

    report = {
        "bg": _resolve(entries[heavy_i]["lab"]),
        "button": _resolve(entries[next_i]["lab"]),
        "accent": _resolve(entries[mid_i]["lab"], bg_rgb, ACCENT_MIN_CONTRAST, "background"),
    }

    ink_seed = _best_contrast_entry(entries, bg_rgb)
    report["ink"] = _resolve(ink_seed["lab"], bg_rgb, BODY_TEXT_MIN_CONTRAST, "background")
    report["muted"] = _resolve(ink_seed["lab"], bg_rgb, SECONDARY_TEXT_MIN_CONTRAST, "background")

    button_ink_seed = _best_contrast_entry(entries, button_rgb)
    report["buttonInk"] = _resolve(
        button_ink_seed["lab"], button_rgb, BUTTON_TEXT_MIN_CONTRAST, "button surface"
    )

    settings = {key: report[key]["hex"] for key in _ROLES}
    return {"settings": settings, "report": report}
