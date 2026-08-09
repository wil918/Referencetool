/**
 * Finding a downloadable PDF on the page.
 *
 * PDFs never show up as an <img> the way a photo does -- a PDF.js-style
 * viewer (which is what most "read this paper in your browser" experiences
 * are, JSTOR included) renders each page to a <canvas>, and canvas content
 * has no URL at all. So rather than trying to detect "page images" and
 * reconstruct a document from them -- fragile, and per scoreImage() often
 * outright impossible if those page renders are exposed as blob: URLs --
 * this looks for the one thing that reliably does have a URL: wherever the
 * page links to, or embeds, the actual PDF file.
 *
 * Deliberately generic (not JSTOR-specific): a plain "Download PDF" link, an
 * <embed>/<object>, an <iframe> pointing at one, or the page itself being a
 * pdf.js viewer instance (recognisable by its own `?file=` URL convention,
 * used by many sites beyond JSTOR since it's Mozilla's viewer). Which of
 * these JSTOR actually uses isn't independently confirmed here -- this is
 * the same "generic first" approach as everywhere else in this codebase,
 * covering the common patterns rather than one site's specific markup.
 */
import { normaliseValue } from "./provenance.js";
import { deepQuerySelectorAll } from "./dom.js";

const PDF_URL_RE = /\.pdf(?:[?#]|$)/i;

/**
 * @returns {Array<{pdf_url: string, title: string, source: string}>}
 */
export function findPdfCandidates(doc = document, win = window) {
  const candidates = [];
  const seen = new Set();

  const push = (url, source, titleHint) => {
    const abs = absolute(url, win);
    if (!abs || seen.has(abs)) return;
    // Same reasoning as image candidates: an in-memory object URL can't be
    // downloaded by the background service worker that has to fetch it.
    if (abs.startsWith("blob:")) return;
    seen.add(abs);
    candidates.push({
      pdf_url: abs,
      title: normaliseValue(titleHint) || filenameFrom(abs),
      source,
    });
  };

  // `citation_pdf_url` is the Highwire Press convention: the publisher
  // declaring, in a meta tag, exactly where the PDF for this article lives.
  // It's what Google Scholar indexes on, so academic publishers have a
  // strong incentive to keep it accurate -- making it by far the most
  // reliable signal available, and worth checking before anything inferred
  // from links or embeds. Pushed first so it ranks first.
  for (const meta of doc.querySelectorAll('meta[name="citation_pdf_url"]')) {
    push(meta.getAttribute("content"), "citation-meta", doc.title);
  }

  // The page itself is a pdf.js viewer instance.
  const ownFile = viewerFileParam(win.location?.href, win);
  if (ownFile) push(ownFile, "viewer-param", doc.title);

  // Everything below scans through open shadow roots as well as the light
  // DOM: sites built from web components keep most of their real markup
  // inside shadow trees, where a plain querySelectorAll would never see it.

  // An embedded viewer, or a directly embedded/framed PDF.
  for (const iframe of deepQuerySelectorAll(doc, "iframe[src]")) {
    const src = iframe.getAttribute("src");
    const framed = viewerFileParam(src, win) || (src && PDF_URL_RE.test(src) ? src : null);
    if (framed) push(framed, "iframe", iframe.getAttribute("title"));
  }

  for (const el of deepQuerySelectorAll(doc, "embed[src], object[data]")) {
    const url = el.getAttribute("src") || el.getAttribute("data");
    const isPdf = el.getAttribute("type") === "application/pdf" || (url && PDF_URL_RE.test(url));
    if (url && isPdf) push(url, "embed", null);
  }

  // An ordinary link to a .pdf file -- a "Download PDF" button is often
  // exactly this, though increasingly it's a scripted custom element with no
  // href at all, which is what site adapters exist to handle.
  for (const a of deepQuerySelectorAll(doc, "a[href]")) {
    const href = a.getAttribute("href");
    if (href && PDF_URL_RE.test(href)) {
      push(href, "link", a.textContent || a.getAttribute("aria-label"));
    }
  }

  return candidates;
}

/** The `file` query param pdf.js-style viewers use for the PDF they're showing. */
function viewerFileParam(url, win = window) {
  if (!url) return null;
  try {
    const u = new URL(url, win.location?.href || undefined);
    if (!/viewer\.html$/i.test(u.pathname)) return null;
    const file = u.searchParams.get("file");
    return file ? decodeURIComponent(file) : null;
  } catch {
    return null;
  }
}

function filenameFrom(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return name || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function absolute(url, win = window) {
  if (!url) return null;
  try {
    return new URL(url, win.location?.href || undefined).href;
  } catch {
    return null;
  }
}
