/* Where the pages of a spread sit inside the region it was drawn as.
 *
 * Pure geometry: no DOM, no imports, nothing but numbers in and numbers out.
 * That is what lets tests/test_spreads.py run this exact file under node
 * rather than a Python copy of it that could drift -- keep it import-free, or
 * that test loses the ability to load it from a data: URL.
 *
 * The region sets the bounds and nothing else. The page count and orientation
 * decide how many fit across, and the page size follows from whichever
 * arrangement lets the pages be largest. A page is always A4 -- the ratio is
 * never bent to fill the region, so a region of the "wrong" shape simply has
 * slack, split evenly around the pages.
 *
 * Spacing is measured in page widths, not world units. A spread resized to
 * half the size keeps the same proportions: the gaps shrink with the pages
 * instead of staying fixed while the pages between them get smaller.
 */

// ISO 216: A4 is 210 x 297 mm, which is 1 : 1.414. Height over width, for a
// portrait page. The PDF export (spreads.py) uses the same two numbers.
export const A4_MM = [210, 297];
export const A4_RATIO = A4_MM[1] / A4_MM[0];

export const ORIENTATIONS = ["portrait", "landscape"];
export const LAYOUTS = ["sequential", "booklet"];
export const FITS = ["contain", "cover"];

// The gap between pages (sequential) or between pairs (booklet), and between
// rows in both, in page widths.
export const DEFAULT_GAP = 0.12;
export const MIN_GAP = 0.04;
export const MAX_GAP = 0.6;

// The gutter inside a booklet pair. Tight, so the two pages read as one
// spread -- but never zero, because two pages touching read as one wide page,
// and never more than half the gap between pairs, or the pairing stops
// reading at all.
export const GUTTER = 0.025;

// A portfolio deliverable is roughly thirty pages, and a spread in progress is
// mostly empty slots -- starting at the real count is what makes the empty
// slots useful rather than something to add to later.
export const DEFAULT_PAGE_COUNT = 30;
export const MAX_PAGE_COUNT = 200;

// Below this a page looks fine on screen and soft on paper. spreads.py's
// MIN_PRINT_DPI is the same number; that side warns at upload, this side keeps
// the warning showing on the page afterwards.
export const MIN_PRINT_DPI = 150;

// How far an image's proportions may be from A4 and still count as A4 -- a
// page exported at 2480 x 3508 is A4, and so is one a pixel or two out.
export const A4_TOLERANCE = 0.01;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** A fresh spread's config: every page an empty slot. */
export function defaultSpreadConfig(count = DEFAULT_PAGE_COUNT) {
  return {
    layout: "sequential",
    orientation: "portrait",
    cover: true,
    gap: DEFAULT_GAP,
    pages: Array.from({ length: count }, () => emptyPage()),
  };
}

export function emptyPage() {
  return { page_id: null, fit: "contain" };
}

/** Page height over page width for an orientation. */
export function pageAspect(orientation) {
  return orientation === "landscape" ? 1 / A4_RATIO : A4_RATIO;
}

/* Lay out `count` pages inside a width x height region.
 *
 * Returns { pageW, pageH, columns, rows, gap, gutter, pages }, all in the
 * region's own units (world units, for a canvas node), where each page is
 * { index, x, y, w, h, unit, side } with x/y relative to the region's
 * top-left. `unit` is the grid cell the page sits in -- one page in the
 * sequential layout, one pair in the booklet layout -- and `side` is "left" or
 * "right" within a pair, or null when there are no pairs.
 *
 * The booklet layout pairs pages the way a printed book does. With a cover,
 * page 1 stands alone on the right (it is a recto, like the first page of any
 * book) and every pair after it is shifted by one: 2-3, 4-5, 6-7. Without
 * one, pages pair from the start: 1-2, 3-4. Nothing is renumbered either way
 * -- page i is always the i-th entry in the spread's order -- only which page
 * shares a pair with which. That is the whole difference, and the reason the
 * cover is an explicit setting rather than something inferred.
 */
export function layoutSpread({
  width,
  height,
  count,
  orientation = "portrait",
  layout = "sequential",
  cover = true,
  gap = DEFAULT_GAP,
}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const aspect = pageAspect(orientation);
  const g = clamp(Number(gap) || DEFAULT_GAP, MIN_GAP, MAX_GAP);
  const booklet = layout === "booklet";
  const gutter = booklet ? Math.min(GUTTER, g / 2) : 0;
  const shift = booklet && cover ? 1 : 0;
  // A grid cell's width, in page widths: one page, or two and a gutter.
  const unitW = booklet ? 2 + gutter : 1;
  const units = booklet ? Math.ceil((n + shift) / 2) : n;

  const empty = { pageW: 0, pageH: 0, columns: 0, rows: 0, gap: 0, gutter: 0, pages: [] };
  if (!units || !(width > 0) || !(height > 0)) return empty;

  // Try every column count and keep whichever gives the largest page. For a
  // given column count the width and the height each cap the page size, and
  // the smaller cap wins; the number of units is small (a few hundred at
  // most), so trying them all is cheaper than being clever about it. Strictly
  // greater, so a tie keeps the arrangement with fewer columns.
  let best = null;
  for (let columns = 1; columns <= units; columns += 1) {
    const rows = Math.ceil(units / columns);
    const byWidth = width / (columns * unitW + (columns - 1) * g);
    const byHeight = height / (rows * aspect + (rows - 1) * g);
    const pageW = Math.min(byWidth, byHeight);
    if (!best || pageW > best.pageW * (1 + 1e-9)) best = { columns, rows, pageW };
  }

  const { columns, rows, pageW } = best;
  const pageH = pageW * aspect;
  const gridW = (columns * unitW + (columns - 1) * g) * pageW;
  const gridH = (rows * aspect + (rows - 1) * g) * pageW;
  // The slack, split evenly, so the pages sit in the middle of the region
  // that was drawn rather than hard against one corner of it.
  const originX = (width - gridW) / 2;
  const originY = (height - gridH) / 2;

  const pages = [];
  for (let index = 0; index < n; index += 1) {
    const slot = index + shift;
    const unit = booklet ? Math.floor(slot / 2) : index;
    const right = booklet && slot % 2 === 1;
    const col = unit % columns;
    const row = Math.floor(unit / columns);
    pages.push({
      index,
      x: originX + (col * (unitW + g) + (right ? 1 + gutter : 0)) * pageW,
      y: originY + row * (aspect + g) * pageW,
      w: pageW,
      h: pageH,
      unit,
      side: booklet ? (right ? "right" : "left") : null,
    });
  }

  return { pageW, pageH, columns, rows, gap: g * pageW, gutter: gutter * pageW, pages };
}

/** The page under a point in the region's own coordinates, or null. */
export function pageAt(layout, x, y) {
  for (const page of layout.pages) {
    if (x >= page.x && x <= page.x + page.w && y >= page.y && y <= page.y + page.h) {
      return page.index;
    }
  }
  return null;
}

/* How an image prints on an A4 page, in dots per inch.
 *
 * Contain scales the image until its tighter side meets the page, so it is
 * the looser side that decides the density; cover scales it until the looser
 * side meets the page and crops the rest, which spreads the same pixels over
 * more paper. spreads.py's print_check is the same arithmetic -- it warns at
 * upload, and this keeps the warning on the page for as long as it applies.
 */
export function printDpi(widthPx, heightPx, orientation = "portrait", fit = "contain") {
  const [shortIn, longIn] = [A4_MM[0] / 25.4, A4_MM[1] / 25.4];
  const [pageWIn, pageHIn] = orientation === "landscape" ? [longIn, shortIn] : [shortIn, longIn];
  const across = widthPx / pageWIn;
  const down = heightPx / pageHIn;
  return fit === "cover" ? Math.min(across, down) : Math.max(across, down);
}

/** Whether an image is A4 in the spread's own orientation -- the case that
 *  lands exactly, where contain and cover are the same thing. */
export function isA4(widthPx, heightPx, orientation = "portrait") {
  if (!(widthPx > 0) || !(heightPx > 0)) return false;
  return Math.abs(heightPx / widthPx / pageAspect(orientation) - 1) <= A4_TOLERANCE;
}
