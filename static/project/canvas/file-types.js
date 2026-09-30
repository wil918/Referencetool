/* What ingest.py can actually open, mirrored here so a drop can be refused
 * client-side before anything uploads. Keep these sets in step with
 * ingest.py's IMAGE_EXTS/TEXT_EXTS/PDF_EXTS -- there is no build step to
 * share the one true list across Python and JS.
 */

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
export const TEXT_EXTS = new Set([".txt", ".md"]);
export const PDF_EXTS = new Set([".pdf"]);
export const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ...TEXT_EXTS, ...PDF_EXTS]);

// Only an image can be shown before it's even uploaded (URL.createObjectURL
// on the dropped File) -- a PDF or text file gets an icon instead.
export const PREVIEWABLE_EXTS = IMAGE_EXTS;

export function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

/** Whether a dropped File is one ingest can add, and -- if not -- a guess at
 *  whether it was actually a folder.
 *
 * A folder read through plain `dataTransfer.files` (no webkitGetAsEntry,
 * which hard rule 5 reserves for real folder handling) arrives as a
 * same-shaped "file": zero bytes, no extension, generic or empty MIME type.
 * That shape isn't proof -- a genuinely empty, extension-less file would read
 * the same way -- so it only ever picks which refusal message to show, never
 * whether to refuse: both cases fail the same extension check and neither is
 * ever opened or uploaded.
 */
export function classifyDrop(file) {
  const ext = extOf(file.name);
  if (SUPPORTED_EXTS.has(ext)) return { ok: true, ext };
  const isFolder = !ext && file.size === 0;
  return { ok: false, isFolder };
}
