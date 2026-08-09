/**
 * The generic extractor -- the one that has to work everywhere.
 *
 * Site-specific adapters exist only to fix cases this genuinely fails. Any
 * improvement that could apply to more than one site belongs here instead.
 */
import { extractPageMetadata } from "../metadata.js";
import { findImages, imageProvenance } from "../images.js";
import { findPdfCandidates } from "../pdf.js";
import { extractSelection } from "../selection.js";
import { Provenance } from "../provenance.js";

export const id = "generic";

/** Always matches -- this is the fallback. */
export function matches() {
  return true;
}

/**
 * Everything capturable on the current page.
 * @returns {{source: Object, metadata: Object, provenance: Array, images: Array, pdfs: Array, selection: Object|null}}
 */
export function extract(doc = document, win = window) {
  const page = extractPageMetadata(doc);
  return {
    source: page.source,
    metadata: page.metadata,
    provenance: page.provenance,
    images: findImages(doc, win),
    pdfs: findPdfCandidates(doc, win),
    selection: extractSelection(win),
  };
}

/**
 * Merge page-level and image-level metadata for one chosen image.
 *
 * Image-level values win where they exist: a figcaption describes the picture,
 * while the page's OpenGraph title describes the article it sits in.
 */
export function mergeForImage(pageResult, candidate) {
  const prov = new Provenance();

  // Image-specific first so it takes priority within equal source ranks.
  for (const record of imageProvenance(candidate).records) {
    prov.records.push(record);
  }
  for (const record of pageResult.provenance) {
    prov.records.push(record);
  }

  return {
    metadata: prov.resolved(),
    metadata_provenance: prov.trail(),
  };
}
