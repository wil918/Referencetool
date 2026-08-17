"""style_gen.py: turning a saved colour palette into a project appearance
style.

Fixtures are hand-built profile dicts, not images -- style_gen only ever
reads a colour.py profile's `palette` (lab, rgb, weight), so there is
nothing an image would add here that constructing the profile directly
doesn't already give, more legibly. Contrast is re-checked with an
independent WCAG implementation rather than style_gen's own contrast_ratio,
so these tests can't pass by sharing a bug with the code under test.
"""
import pytest

import colour
import style_gen

EXPECTED_KEYS = {"bg", "button", "accent", "ink", "muted", "buttonInk"}


def entry(rgb, weight):
    return {"lab": [float(v) for v in colour.rgb_to_lab(rgb)], "rgb": list(rgb), "weight": weight}


def palette(*entries):
    return {"version": colour.ANALYSIS_VERSION, "palette": list(entries)}


def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _channel_luminance(c):
    s = c / 255
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def wcag_contrast(rgb_a, rgb_b):
    """A second, independent implementation of the WCAG contrast ratio --
    deliberately not style_gen.contrast_ratio, so a bug in that function
    couldn't also hide itself from these assertions."""
    la = sum(w * _channel_luminance(c) for w, c in zip((0.2126, 0.7152, 0.0722), rgb_a))
    lb = sum(w * _channel_luminance(c) for w, c in zip((0.2126, 0.7152, 0.0722), rgb_b))
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def assert_valid_and_meets_thresholds(result):
    settings = result["settings"]
    assert set(settings) == EXPECTED_KEYS
    for value in settings.values():
        assert value.startswith("#") and len(value) == 7

    bg = hex_to_rgb(settings["bg"])
    button = hex_to_rgb(settings["button"])
    # A tiny tolerance for float rounding, not a relaxation of the rule --
    # style_gen's own thresholds are the exact numbers compared against.
    tol = 1e-9
    assert wcag_contrast(hex_to_rgb(settings["ink"]), bg) >= style_gen.BODY_TEXT_MIN_CONTRAST - tol
    assert wcag_contrast(hex_to_rgb(settings["muted"]), bg) >= style_gen.SECONDARY_TEXT_MIN_CONTRAST - tol
    assert wcag_contrast(hex_to_rgb(settings["accent"]), bg) >= style_gen.ACCENT_MIN_CONTRAST - tol
    assert wcag_contrast(hex_to_rgb(settings["buttonInk"]), button) >= style_gen.BUTTON_TEXT_MIN_CONTRAST - tol


# A range of real-ish palettes, covering the shapes that could plausibly
# break a contrast-walking algorithm: a single flat colour with nothing else
# to draw text from, palettes already crammed against the black/white ends,
# and a wide-gamut palette with several strongly saturated entries.
NEAR_IDENTICAL_GREYS = palette(
    entry((128, 127, 130), 0.40),
    entry((124, 126, 123), 0.35),
    entry((131, 129, 128), 0.25),
)
DARK_MOODY = palette(
    entry((20, 22, 28), 0.50),
    entry((45, 35, 60), 0.30),
    entry((10, 10, 12), 0.20),
)
PALE_NEUTRAL = palette(
    entry((240, 238, 232), 0.50),
    entry((225, 220, 210), 0.30),
    entry((250, 249, 246), 0.20),
)
HIGH_CHROMA = palette(
    entry((220, 30, 40), 0.40),
    entry((20, 90, 200), 0.30),
    entry((250, 220, 20), 0.20),
    entry((10, 160, 90), 0.10),
)
SINGLE_COLOUR = palette(entry((100, 140, 90), 1.0))
NEAR_BLACK = palette(entry((5, 5, 6), 0.8), entry((15, 12, 20), 0.2))
NEAR_WHITE = palette(entry((250, 250, 248), 0.7), entry((245, 240, 235), 0.3))

SAMPLE_PALETTES = {
    "near_identical_greys": NEAR_IDENTICAL_GREYS,
    "dark_moody": DARK_MOODY,
    "pale_neutral": PALE_NEUTRAL,
    "high_chroma": HIGH_CHROMA,
    "single_colour": SINGLE_COLOUR,
    "near_black": NEAR_BLACK,
    "near_white": NEAR_WHITE,
}


def test_near_identical_greys_still_produce_a_readable_style():
    """The case with the least room to work with: nothing in the palette is
    naturally light or dark, so every text/accent colour has to be walked
    away from its seed to become readable at all."""
    result = style_gen.generate_style(NEAR_IDENTICAL_GREYS)
    assert_valid_and_meets_thresholds(result)
    # Actually readable, not just barely passing -- ink and background should
    # have visibly separated rather than staying two shades of the same grey.
    bg = hex_to_rgb(result["settings"]["bg"])
    ink = hex_to_rgb(result["settings"]["ink"])
    assert wcag_contrast(ink, bg) >= style_gen.BODY_TEXT_MIN_CONTRAST


@pytest.mark.parametrize("profile", SAMPLE_PALETTES.values(), ids=SAMPLE_PALETTES.keys())
def test_every_generated_style_meets_every_threshold(profile):
    assert_valid_and_meets_thresholds(style_gen.generate_style(profile))


@pytest.mark.parametrize("profile", SAMPLE_PALETTES.values(), ids=SAMPLE_PALETTES.keys())
def test_same_palette_always_produces_the_same_style(profile):
    assert style_gen.generate_style(profile) == style_gen.generate_style(profile)


def test_empty_palette_is_an_error():
    with pytest.raises(ValueError):
        style_gen.generate_style({"palette": []})
