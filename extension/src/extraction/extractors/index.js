/**
 * Extractor registry.
 *
 * A site adapter earns its place only when the generic extractor genuinely
 * fails on that site -- otherwise the fix belongs in the generic path where
 * every site benefits. Adapters here are deliberately thin: they run the
 * generic extraction, then correct or add what the site does differently.
 */
import * as generic from "./generic.js";
import * as pinterest from "./pinterest.js";
import * as jstor from "./jstor.js";

/** Ordered: first match wins, generic is the fallback and must stay last. */
const ADAPTERS = [pinterest, jstor, generic];

/** The extractor for a hostname. */
export function extractorFor(hostname = location.hostname) {
  const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
  return ADAPTERS.find((a) => a.matches(host)) || generic;
}

/** Run the right extractor for the current page. */
export function extractPage(doc = document, win = window) {
  const extractor = extractorFor(win.location?.hostname);
  const result = extractor.extract(doc, win);
  return { ...result, extractor: extractor.id };
}

/** Merge page + image metadata using the matching extractor's rules. */
export function mergeForImage(pageResult, candidate, hostname = location.hostname) {
  const extractor = extractorFor(hostname);
  const merge = extractor.mergeForImage || generic.mergeForImage;
  return merge(pageResult, candidate);
}

export { generic };
