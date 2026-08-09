/**
 * Finding the images on a page that are actually worth saving.
 *
 * The hard part isn't collecting `<img>` elements, it's rejecting the ~90% of
 * them that are interface furniture: logos, avatars, share icons, spacers,
 * tracking pixels. Rather than a blocklist of sites, this scores every
 * candidate on signals that generalise -- size, shape, where it sits in the
 * document, and whether anyone bothered to describe it.
 */
import { Provenance, normaliseValue } from "./provenance.js";

/** Below this rendered/intrinsic area, it's an icon, not a reference. */
const MIN_AREA = 150 * 150;
/** Hard floor on either edge -- catches wide-but-thin banners and spacers. */
const MIN_EDGE = 100;
/** Beyond this ratio it's a divider, banner or sprite sheet, not an image. */
const MAX_ASPECT = 4.5;

/** Substrings in a URL, id, class or alt that reliably mean "not content". */
const JUNK_PATTERNS = [
  "sprite", "logo", "icon", "avatar", "favicon", "placeholder", "spacer",
  "pixel", "tracking", "beacon", "analytics", "badge", "button", "arrow",
  "chevron", "bullet", "divider", "watermark", "advert", "banner-ad",
  "profile-pic", "thumb-nav", "emoji",
];

/** Containers whose images are navigation/branding rather than content. */
const CHROME_SELECTORS = "header, footer, nav, aside, [role=banner], [role=navigation], [role=contentinfo]";
/** Containers that signal an image is the actual subject of the page. */
const CONTENT_SELECTORS = "figure, article, main, [role=main], picture, .gallery, [itemprop=image]";

/**
 * Every image on the page worth offering, best first.
 * @returns {Array<Object>} candidate descriptors
 */
export function findImages(doc = document, win = window) {
  const seen = new Set();
  /** @type {Array<Object>} */
  const candidates = [];

  const push = (candidate) => {
    if (!candidate || !candidate.image_url) return;
    const key = stripQuery(candidate.image_url);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const img of doc.querySelectorAll("img")) push(describeImg(img, win));
  for (const el of doc.querySelectorAll("[style*='background-image']")) {
    push(describeBackground(el, win));
  }
  for (const c of socialCardImages(doc)) push(c);

  return candidates
    .map((c) => ({ ...c, score: scoreImage(c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Build a candidate from an <img>, resolving lazy and responsive sources. */
export function describeImg(img, win = window) {
  const url = bestSource(img);
  if (!url) return null;

  const rect = typeof img.getBoundingClientRect === "function"
    ? img.getBoundingClientRect()
    : { width: 0, height: 0 };

  return {
    image_url: url,
    // The <img> may be a downscaled srcset pick; a full-resolution original is
    // often reachable and is what should actually be archived.
    original_image_url: highestResolution(img) || null,
    image_alt: normaliseValue(img.getAttribute("alt")),
    image_title: normaliseValue(img.getAttribute("title")),
    caption: nearestCaption(img),
    credit: nearestCredit(img),
    intrinsic_width: img.naturalWidth || 0,
    intrinsic_height: img.naturalHeight || 0,
    rendered_width: Math.round(rect.width) || 0,
    rendered_height: Math.round(rect.height) || 0,
    hidden: isHidden(img, win),
    in_content: Boolean(img.closest?.(CONTENT_SELECTORS)),
    in_chrome: Boolean(img.closest?.(CHROME_SELECTORS)),
    in_link: Boolean(img.closest?.("a")),
    link_href: img.closest?.("a")?.href || null,
    kind: "img",
  };
}

/** Build a candidate from a CSS background-image. */
export function describeBackground(el, win = window) {
  const style = win.getComputedStyle ? win.getComputedStyle(el) : null;
  const raw = style?.backgroundImage || "";
  const match = /url\(["']?(.*?)["']?\)/.exec(raw);
  if (!match || !match[1] || match[1].startsWith("data:")) return null;

  const rect = typeof el.getBoundingClientRect === "function"
    ? el.getBoundingClientRect()
    : { width: 0, height: 0 };

  return {
    image_url: absolute(match[1]),
    original_image_url: null,
    image_alt: normaliseValue(el.getAttribute?.("aria-label")),
    image_title: "",
    caption: nearestCaption(el),
    credit: "",
    // A background image reports no intrinsic size, so rendered size is the
    // only signal available -- scoreImage falls back to it.
    intrinsic_width: 0,
    intrinsic_height: 0,
    rendered_width: Math.round(rect.width) || 0,
    rendered_height: Math.round(rect.height) || 0,
    hidden: isHidden(el, win),
    in_content: Boolean(el.closest?.(CONTENT_SELECTORS)),
    in_chrome: Boolean(el.closest?.(CHROME_SELECTORS)),
    in_link: Boolean(el.closest?.("a")),
    link_href: el.closest?.("a")?.href || null,
    kind: "background",
  };
}

/**
 * The OpenGraph/Twitter card image.
 *
 * Worth including because on some pages (and most social posts) it's the only
 * full-resolution copy of the subject, and it's the publisher's own pick.
 */
export function socialCardImages(doc = document) {
  const out = [];
  const seen = new Set();
  const selectors = [
    ['meta[property="og:image"]', "opengraph"],
    ['meta[property="og:image:secure_url"]', "opengraph"],
    ['meta[name="twitter:image"]', "twitter"],
  ];
  for (const [selector, origin] of selectors) {
    for (const el of doc.querySelectorAll(selector)) {
      const url = absolute(el.getAttribute("content"));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        image_url: url,
        original_image_url: null,
        image_alt: "",
        image_title: "",
        caption: "",
        credit: "",
        intrinsic_width: 0,
        intrinsic_height: 0,
        rendered_width: 0,
        rendered_height: 0,
        hidden: false,
        in_content: true,
        in_chrome: false,
        in_link: false,
        link_href: null,
        kind: "social-card",
        card_origin: origin,
      });
    }
  }
  return out;
}

/**
 * Score a candidate. Zero or below means "don't show this".
 *
 * Deliberately additive and readable rather than tuned -- the goal is a
 * sensible ordering with obvious junk removed, not a precise ranking.
 */
export function scoreImage(c) {
  if (!c.image_url) return 0;
  // A blob: URL is an in-memory object URL, valid only inside the exact
  // document that created it via URL.createObjectURL() -- it is not a
  // network resource, so no host permission makes it reachable from the
  // background service worker that actually has to download it. Offering it
  // as a candidate would always fail to save, on any site: PDF.js viewers
  // (JSTOR among them) commonly render pages to canvas and expose them this
  // way, but so do plenty of client-side image editors and video frame
  // grabbers, so this isn't a site-specific rule.
  if (c.image_url.startsWith("blob:")) return 0;
  if (c.image_url.startsWith("data:") && c.image_url.length < 512) return 0; // inline icon

  // A social card image has no measurable geometry, but the publisher chose it
  // explicitly, so it's admitted on that basis alone.
  if (c.kind === "social-card") return 60;

  if (looksLikeJunk(c)) return 0;

  const intrinsicArea = c.intrinsic_width * c.intrinsic_height;
  const renderedArea = c.rendered_width * c.rendered_height;
  const area = Math.max(intrinsicArea, renderedArea);
  if (area && area < MIN_AREA) return 0;

  const w = c.intrinsic_width || c.rendered_width;
  const h = c.intrinsic_height || c.rendered_height;
  if (w && h) {
    if (Math.min(w, h) < MIN_EDGE) return 0;
    const aspect = Math.max(w / h, h / w);
    if (aspect > MAX_ASPECT) return 0;
  } else if (!area) {
    // Nothing measurable at all (a lazy image not yet loaded, or an offscreen
    // slide). Keep it, but rank it below anything we could actually size.
    let unmeasured = c.in_content ? 25 : 10;
    if (c.hidden) unmeasured -= 8;
    if (c.caption || c.image_alt) unmeasured += 5;
    return Math.max(1, unmeasured);
  }

  let score = 0;
  score += Math.min(50, Math.sqrt(area) / 12); // bigger is better, with strong diminishing returns
  if (c.in_content) score += 25;
  if (c.in_chrome) score -= 40;
  if (c.image_alt && c.image_alt.length > 3) score += 12;
  if (c.caption) score += 15;
  if (c.credit) score += 8;
  if (c.original_image_url) score += 5;
  if (c.kind === "background") score -= 8; // usually decorative
  // Heavy, but not disqualifying: an inactive carousel slide is still a real
  // image, it just shouldn't outrank what's actually on screen.
  if (c.hidden) score -= 30;

  return Math.max(0, Math.round(score));
}

/** Does anything about this element say "interface furniture"? */
export function looksLikeJunk(c) {
  const haystack = [c.image_url, c.image_alt, c.className, c.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return JUNK_PATTERNS.some((p) => haystack.includes(p));
}

/**
 * The URL an <img> is actually showing, accounting for lazy-loading.
 *
 * Lazy loaders park the real URL in a data attribute and leave `src` as a
 * placeholder, so `src` alone would capture a grey blur on a lot of sites.
 */
export function bestSource(img) {
  const lazyAttrs = [
    "data-src", "data-original", "data-lazy-src", "data-lazy",
    "data-hi-res-src", "data-full-src", "data-image", "data-srcset",
  ];
  for (const attr of lazyAttrs) {
    const value = img.getAttribute?.(attr);
    if (!value) continue;
    const url = attr.endsWith("srcset") ? widestFromSrcset(value) : value;
    if (url && !isPlaceholder(url)) return absolute(url);
  }

  const fromSrcset = widestFromSrcset(img.getAttribute?.("srcset"));
  if (fromSrcset) return absolute(fromSrcset);

  const src = img.currentSrc || img.getAttribute?.("src") || img.src;
  if (src && !isPlaceholder(src)) return absolute(src);
  return null;
}

/**
 * The largest source available, if it differs from what's displayed --
 * checking the parent <picture> too, since that's where the big one often is.
 */
export function highestResolution(img) {
  const sets = [img.getAttribute?.("srcset")];
  const picture = img.closest?.("picture");
  if (picture) {
    for (const source of picture.querySelectorAll("source")) {
      sets.push(source.getAttribute("srcset"));
    }
  }
  let best = null;
  let bestWidth = 0;
  for (const set of sets) {
    const parsed = parseSrcset(set);
    for (const { url, width } of parsed) {
      if (width > bestWidth) {
        bestWidth = width;
        best = url;
      }
    }
  }
  return best ? absolute(best) : null;
}

export function widestFromSrcset(srcset) {
  const parsed = parseSrcset(srcset);
  if (!parsed.length) return null;
  parsed.sort((a, b) => b.width - a.width);
  return parsed[0].url;
}

/** Parse a srcset into {url, width} pairs. Handles both `w` and `x`. */
export function parseSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return [];
  return srcset
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor] = part.split(/\s+/);
      if (!url) return null;
      let width = 0;
      if (descriptor) {
        const w = /^(\d+)w$/.exec(descriptor);
        const x = /^([\d.]+)x$/.exec(descriptor);
        // Density descriptors have no pixel width; scale them so a 2x still
        // sorts above a 1x without pretending to know the real dimensions.
        if (w) width = parseInt(w[1], 10);
        else if (x) width = Math.round(parseFloat(x[1]) * 1000);
      }
      return { url, width };
    })
    .filter(Boolean);
}

/** Caption text tied to an image, if the markup provides one. */
export function nearestCaption(el) {
  const figure = el.closest?.("figure");
  const caption = figure?.querySelector("figcaption");
  if (caption) return normaliseValue(caption.textContent);

  const labelled = el.getAttribute?.("aria-describedby");
  if (labelled) {
    const target = el.ownerDocument?.getElementById(labelled);
    if (target) return normaliseValue(target.textContent);
  }
  return "";
}

/** A credit/attribution line near the image, if present. */
export function nearestCredit(el) {
  const scope = el.closest?.("figure") || el.parentElement;
  if (!scope?.querySelector) return "";
  const credit = scope.querySelector(
    "[class*=credit], [class*=copyright], [itemprop=creditText], .caption-credit"
  );
  return credit ? normaliseValue(credit.textContent) : "";
}

/**
 * Explicitly hidden -- not merely unmeasured.
 *
 * Deliberately does NOT treat a zero-size box as hidden. Plenty of images
 * worth saving have no layout at the moment we look: gallery slides that
 * haven't been advanced to, lightbox contents, and lazy images that haven't
 * been laid out yet. Those are penalised in scoreImage rather than dropped,
 * so a carousel's later slides still show up, just below the visible ones.
 */
function isHidden(el, win) {
  if (!win?.getComputedStyle) return false;
  let style;
  try {
    style = win.getComputedStyle(el);
  } catch {
    return false;
  }
  // An element outside a rendered document reports no computed display at
  // all; that's "unknown", not "hidden".
  if (!style || !style.display) return false;
  if (style.display === "none" || style.visibility === "hidden") return true;
  return parseFloat(style.opacity || "1") < 0.05;
}

function isPlaceholder(url) {
  if (!url) return true;
  if (url.startsWith("data:image/gif")) return true;
  if (url.startsWith("data:image/svg") && url.length < 512) return true;
  return /(^|\/)(blank|placeholder|loading|spacer)\.(gif|png|svg)/i.test(url);
}

function stripQuery(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function absolute(url) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

/** Provenance records for one chosen image. Exported for the capture builder. */
export function imageProvenance(candidate) {
  const prov = new Provenance();
  prov.add("caption", candidate.caption, "figcaption");
  prov.add("credit", candidate.credit, "figcaption");
  prov.add("description", candidate.image_alt, "attribute");
  prov.add("title", candidate.image_title, "attribute");
  return prov;
}
