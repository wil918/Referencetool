/**
 * Building the capture envelope the backend accepts.
 *
 * One shape for images, text and pages, so the API only has to understand a
 * single schema. This is the boundary: everything above works with DOM and
 * candidates, everything below is plain JSON headed for the archive.
 */
import { mergeForImage } from "./extractors/index.js";

/**
 * @param {Object} pageResult  from extractPage()
 * @param {Object} candidate   the chosen image
 * @param {{user_note?: string, project_ids?: string[]}} [opts]
 */
export function buildImageCapture(pageResult, candidate, opts = {}) {
  const merged = mergeForImage(pageResult, candidate, pageResult.source?.domain);
  return {
    type: "image",
    source: { ...pageResult.source },
    content: {
      // What we'll actually download. Prefer the full-resolution original
      // where the page exposed one -- that's the copy worth archiving.
      image_url: candidate.original_image_url || candidate.image_url,
      displayed_image_url: candidate.image_url,
      image_alt: candidate.image_alt || "",
      selected_text: null,
    },
    metadata: merged.metadata,
    metadata_provenance: merged.metadata_provenance,
    project_ids: opts.project_ids || [],
    user_note: opts.user_note || "",
    extractor: pageResult.extractor,
  };
}

/** @param {Object} pageResult @param {Object} selection @param {Object} [opts] */
export function buildTextCapture(pageResult, selection, opts = {}) {
  const metadata = { ...pageResult.metadata };
  if (selection.heading) metadata.heading = selection.heading;

  return {
    type: "text",
    source: { ...pageResult.source },
    content: {
      // Exactly what was highlighted, untouched.
      selected_text: selection.selected_text,
      context: selection.context || "",
      image_url: null,
    },
    metadata,
    metadata_provenance: pageResult.provenance,
    project_ids: opts.project_ids || [],
    user_note: opts.user_note || "",
    extractor: pageResult.extractor,
  };
}

/**
 * A whole page as a reference.
 *
 * Stores what the page says about itself plus the URL -- never a copy of the
 * page body, which would be reproducing someone else's work wholesale.
 */
export function buildPageCapture(pageResult, opts = {}) {
  const excerpt = [
    pageResult.source?.page_title,
    pageResult.metadata?.description,
    pageResult.source?.url,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    type: "page",
    source: { ...pageResult.source },
    content: {
      selected_text: excerpt,
      context: "",
      image_url: representativeImage(pageResult),
    },
    metadata: pageResult.metadata,
    metadata_provenance: pageResult.provenance,
    project_ids: opts.project_ids || [],
    user_note: opts.user_note || "",
    extractor: pageResult.extractor,
  };
}

/**
 * A whole PDF as a single reference, rather than trying to reconstruct one
 * out of individually-selected page images (see extraction/pdf.js for why
 * that doesn't work reliably -- a canvas-rendered page has no URL at all,
 * and where it does, it's often a blob: URL nothing outside the page can
 * fetch). The archive already knows how to ingest a PDF wholesale --
 * extracting its text and largest embedded figures itself -- once it can
 * tell one apart from an image, which it does by file extension.
 *
 * Reuses `content.image_url` as the field the bytes get downloaded from,
 * same as an image capture: the whole download/upload path (download.js,
 * api.js's filenameFor, the backend's own extension sniffing) already
 * treats that field as "the URL to fetch and upload", already recognises a
 * `.pdf` extension and an `application/pdf` response, and none of it needs
 * to know or care that this particular capture isn't a photo.
 */
export function buildPdfCapture(pageResult, candidate, opts = {}) {
  return {
    type: "pdf",
    source: { ...pageResult.source },
    content: {
      image_url: candidate.pdf_url,
      displayed_image_url: candidate.pdf_url,
      image_alt: candidate.title || "",
      selected_text: null,
    },
    metadata: pageResult.metadata,
    metadata_provenance: pageResult.provenance,
    project_ids: opts.project_ids || [],
    user_note: opts.user_note || "",
    extractor: pageResult.extractor,
  };
}

/** The page's own pick of image, else the best-scoring one found. */
export function representativeImage(pageResult) {
  const images = pageResult.images || [];
  const card = images.find((i) => i.kind === "social-card");
  return (card || images[0])?.image_url || null;
}
