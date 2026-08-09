/**
 * JSTOR.
 *
 * Earns an adapter because its download control is a scripted web component
 * rather than a link, so there is no href anywhere for the generic detector
 * to find:
 *
 *   <mfe-download-pharos-button data-doi="1399493" data-qa="download-pdf"
 *                               a11y-label="Download" ...>Download</...>
 *
 * The identifier is right there in `data-doi`, and JSTOR's PDF endpoint is a
 * documented, stable URL shape built from it -- so the URL is reconstructed
 * rather than scraped.
 *
 * IMPORTANT, and worth stating plainly: the endpoint shape below is inferred
 * from JSTOR's long-standing public URL convention, NOT verified against a
 * live article -- reaching one needs institutional credentials this code was
 * written without. `citation_pdf_url` (handled in the generic extractor) is
 * checked first precisely because it's the publisher's own declaration and
 * needs no such guesswork; this runs as the fallback for when that tag isn't
 * present. If JSTOR changes the convention, this adapter is the one place to
 * correct, and the generic path keeps working regardless.
 */
import * as generic from "./generic.js";
import { deepQuerySelector } from "../dom.js";

export const id = "jstor";

export function matches(host) {
  return host === "jstor.org" || host.endsWith(".jstor.org");
}

export function extract(doc = document, win = window) {
  const result = generic.extract(doc, win);

  const derived = derivedPdf(doc, win);
  if (derived && !result.pdfs.some((p) => samePdf(p.pdf_url, derived.pdf_url))) {
    // Appended, not prepended: a `citation_pdf_url` the publisher actually
    // declared outranks anything reconstructed from an id.
    result.pdfs.push(derived);
  }
  return result;
}

export const mergeForImage = generic.mergeForImage;

/**
 * The article's stable identifier.
 *
 * Two independent sources, because either can be absent: the download
 * button's own `data-doi` (present on an article page, and searched through
 * shadow roots since the whole UI is web components), and failing that the
 * `/stable/<id>` path segment the page is served under.
 */
export function stableId(doc = document, win = window) {
  const button = deepQuerySelector(
    doc,
    "[data-qa='download-pdf'], mfe-download-pharos-button, [data-doi]"
  );
  const fromButton = button?.getAttribute("data-doi");
  if (fromButton) return fromButton.trim();

  const path = win.location?.pathname || "";
  const match = /\/stable\/(.+?)\/?$/.exec(path);
  if (!match) return null;

  // `/stable/pdf/1399493.pdf` and `/stable/10.2307/1399493` are both valid
  // ways to arrive here; normalise both back to the bare identifier.
  return match[1].replace(/^pdf\//, "").replace(/\.pdf$/i, "") || null;
}

/** The PDF URL for this article, reconstructed from its identifier. */
export function derivedPdf(doc = document, win = window) {
  const id_ = stableId(doc, win);
  if (!id_) return null;

  const origin = win.location?.origin || "https://www.jstor.org";
  // acceptTC=true skips the terms-and-conditions interstitial that would
  // otherwise return an HTML page instead of the file.
  const url = `${origin}/stable/pdf/${id_}.pdf?acceptTC=true`;

  return {
    pdf_url: url,
    title: (doc.title || `${id_}.pdf`).trim(),
    source: "jstor-id",
  };
}

/** Compare ignoring the query string, so `?acceptTC=true` isn't a difference. */
function samePdf(a, b) {
  const strip = (u) => {
    try {
      const parsed = new URL(u);
      return parsed.origin + parsed.pathname;
    } catch {
      return u;
    }
  };
  return strip(a) === strip(b);
}
