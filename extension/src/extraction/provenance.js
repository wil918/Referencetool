/**
 * Metadata provenance.
 *
 * Every extracted value carries where it came from and how much to trust it,
 * because page metadata is frequently wrong, stale, or describes the site
 * rather than the thing you actually saved. Keeping the origin means a value
 * can be judged later instead of being taken at face value.
 *
 * Sources are ordered best-first. The order matters: `collect()` keeps the
 * first value it sees for a field, so higher-confidence extractors must run
 * before lower-confidence ones.
 */

/** @typedef {"json-ld"|"opengraph"|"twitter"|"dublin-core"|"meta"|"attribute"|"figcaption"|"nearby-text"|"inferred"} MetadataSource */

/**
 * Confidence per source.
 *
 * `high` means the publisher stated it in machine-readable form. `medium`
 * means it came from markup meant for humans but structurally tied to the
 * content. `low` means we guessed from proximity, which is often wrong.
 */
export const SOURCE_CONFIDENCE = {
  "json-ld": "high",
  opengraph: "high",
  "dublin-core": "high",
  twitter: "medium",
  meta: "medium",
  attribute: "medium",
  figcaption: "medium",
  "nearby-text": "low",
  // Nothing in this build produces `inferred` -- it exists so that if an AI
  // normalisation step is added later, guessed values are visibly separable
  // from ones the page actually stated. Never apply it to scraped values.
  inferred: "low",
};

/** Priority order for resolving competing values (spec: structured first). */
export const SOURCE_PRIORITY = [
  "json-ld",
  "opengraph",
  "dublin-core",
  "twitter",
  "meta",
  "attribute",
  "figcaption",
  "nearby-text",
  "inferred",
];

/**
 * Accumulates {field, value, source, confidence} records and resolves the
 * winning value per field.
 */
export class Provenance {
  constructor() {
    /** @type {Array<{field: string, value: string, source: MetadataSource, confidence: string}>} */
    this.records = [];
  }

  /**
   * Record a value for a field. Blank values are dropped rather than stored,
   * so an empty `<meta>` never outranks a real value found further down.
   */
  add(field, value, source) {
    const clean = normaliseValue(value);
    if (!clean) return this;
    if (!SOURCE_CONFIDENCE[source]) throw new Error(`unknown provenance source: ${source}`);
    this.records.push({
      field,
      value: clean,
      source,
      confidence: SOURCE_CONFIDENCE[source],
    });
    return this;
  }

  /** Add many fields from one source at once. */
  addAll(fields, source) {
    for (const [field, value] of Object.entries(fields || {})) {
      this.add(field, value, source);
    }
    return this;
  }

  /** The best value for one field, by source priority. */
  best(field) {
    const candidates = this.records.filter((r) => r.field === field);
    if (!candidates.length) return null;
    candidates.sort(
      (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source)
    );
    return candidates[0];
  }

  /** Flat {field: value} of the winning value for every field seen. */
  resolved() {
    const out = {};
    for (const { field } of this.records) {
      if (field in out) continue;
      const winner = this.best(field);
      if (winner) out[field] = winner.value;
    }
    return out;
  }

  /**
   * One record per field -- the winner and where it came from.
   * This is what ships to the backend as `metadata_provenance`.
   */
  trail() {
    const seen = new Set();
    const out = [];
    for (const { field } of this.records) {
      if (seen.has(field)) continue;
      seen.add(field);
      const winner = this.best(field);
      if (winner) out.push({ ...winner });
    }
    return out;
  }
}

/**
 * Tidy a raw extracted string.
 *
 * Collapses the runs of whitespace and newlines that come from reading text
 * out of markup, and rejects values that are technically strings but carry no
 * information (empty, "null", "undefined" -- all of which really do appear in
 * `<meta>` tags in the wild).
 */
export function normaliseValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) value = value.filter(Boolean).join(", ");
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return "";

  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (["null", "undefined", "none", "n/a"].includes(clean.toLowerCase())) return "";
  return clean;
}
