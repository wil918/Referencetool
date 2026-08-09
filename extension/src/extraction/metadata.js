/**
 * Page-level metadata extraction.
 *
 * Runs the priority chain from the spec: explicit structured metadata first,
 * then progressively weaker sources, never overwriting a stronger value with
 * a weaker one (Provenance.best handles that ordering).
 *
 * Everything here is defensive. Real pages ship malformed JSON-LD, duplicate
 * meta tags, arrays where a string is expected, and `@graph` wrappers -- none
 * of which should stop a capture from happening.
 */
import { Provenance, normaliseValue } from "./provenance.js";

/** Schema.org types worth treating as "the thing on this page". */
const PREFERRED_LD_TYPES = [
  "VisualArtwork",
  "Photograph",
  "ImageObject",
  "CreativeWork",
  "Article",
  "ScholarlyArticle",
  "NewsArticle",
  "BlogPosting",
  "Product",
  "WebPage",
];

/**
 * Extract everything we can about the page itself.
 * @param {Document} doc
 * @returns {{metadata: Object, provenance: Array, source: Object}}
 */
export function extractPageMetadata(doc = document) {
  const prov = new Provenance();

  // 1. JSON-LD / Schema.org -- the publisher's own machine-readable claim.
  for (const node of readJsonLd(doc)) {
    prov.addAll(mapSchemaOrg(node), "json-ld");
  }

  // 2. OpenGraph.
  prov.addAll(
    {
      title: metaContent(doc, "property", "og:title"),
      description: metaContent(doc, "property", "og:description"),
      publication: metaContent(doc, "property", "og:site_name"),
      date: metaContent(doc, "property", "article:published_time"),
      modified_date: metaContent(doc, "property", "article:modified_time"),
      author: metaContent(doc, "property", "article:author"),
    },
    "opengraph"
  );

  // 3. Dublin Core -- common on museum and library systems.
  prov.addAll(
    {
      title: metaContent(doc, "name", "DC.title") || metaContent(doc, "name", "dc.title"),
      creator: metaContent(doc, "name", "DC.creator") || metaContent(doc, "name", "dc.creator"),
      date: metaContent(doc, "name", "DC.date") || metaContent(doc, "name", "dc.date"),
      publisher:
        metaContent(doc, "name", "DC.publisher") || metaContent(doc, "name", "dc.publisher"),
      description:
        metaContent(doc, "name", "DC.description") || metaContent(doc, "name", "dc.description"),
      medium: metaContent(doc, "name", "DC.format") || metaContent(doc, "name", "dc.format"),
    },
    "dublin-core"
  );

  // 4. Twitter card.
  prov.addAll(
    {
      title: metaContent(doc, "name", "twitter:title"),
      description: metaContent(doc, "name", "twitter:description"),
      creator: metaContent(doc, "name", "twitter:creator"),
    },
    "twitter"
  );

  // 5. Ordinary meta tags and citation_* (used heavily by academic publishers).
  prov.addAll(
    {
      description: metaContent(doc, "name", "description"),
      author: metaContent(doc, "name", "author"),
      keywords: metaContent(doc, "name", "keywords"),
      title: metaContent(doc, "name", "citation_title"),
      publication: metaContent(doc, "name", "citation_journal_title"),
      date: metaContent(doc, "name", "citation_publication_date"),
      doi: metaContent(doc, "name", "citation_doi"),
      volume: metaContent(doc, "name", "citation_volume"),
      issue: metaContent(doc, "name", "citation_issue"),
      publisher: metaContent(doc, "name", "citation_publisher"),
    },
    "meta"
  );

  // citation_author repeats per author rather than using a delimiter.
  const citationAuthors = [...doc.querySelectorAll('meta[name="citation_author"]')]
    .map((m) => m.getAttribute("content"))
    .filter(Boolean);
  if (citationAuthors.length) prov.add("author", citationAuthors.join(", "), "meta");

  // 6. Last resort for a title: the <title> element.
  prov.add("title", doc.title, "attribute");

  return {
    metadata: prov.resolved(),
    provenance: prov.trail(),
    source: extractSource(doc),
  };
}

/**
 * The provenance chain for the page itself: where this was captured from.
 * Kept separate from `metadata` because these are facts about the capture,
 * not claims made by the page.
 */
export function extractSource(doc = document) {
  const canonical = doc.querySelector('link[rel="canonical"]')?.href || null;
  const ogUrl = metaContent(doc, "property", "og:url");
  let url = null;
  try {
    url = doc.location?.href || null;
  } catch {
    url = null;
  }

  let domain = "";
  try {
    domain = (doc.location?.hostname || "").replace(/^www\./, "");
  } catch {
    domain = "";
  }

  return {
    url,
    canonical_url: normaliseValue(canonical) || normaliseValue(ogUrl) || url,
    domain,
    page_title: normaliseValue(doc.title),
    captured_at: new Date().toISOString(),
  };
}

/** Parse every JSON-LD block, flattening @graph and arrays. */
export function readJsonLd(doc = document) {
  const nodes = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent || "");
    } catch {
      continue; // malformed JSON-LD is extremely common -- just skip it
    }
    collectNodes(parsed, nodes);
  }

  // Put the most content-like types first so their values win.
  nodes.sort((a, b) => ldTypeRank(a) - ldTypeRank(b));
  return nodes;
}

function collectNodes(value, out) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => collectNodes(v, out));
    return;
  }
  if (Array.isArray(value["@graph"])) {
    value["@graph"].forEach((v) => collectNodes(v, out));
  }
  if (value["@type"] || value.name || value.headline) out.push(value);
}

function ldTypeRank(node) {
  const types = [].concat(node["@type"] || []).map(String);
  let best = PREFERRED_LD_TYPES.length;
  for (const t of types) {
    const i = PREFERRED_LD_TYPES.indexOf(t);
    if (i !== -1 && i < best) best = i;
  }
  return best;
}

/** Map a Schema.org node onto our flat metadata field names. */
export function mapSchemaOrg(node) {
  if (!node || typeof node !== "object") return {};
  return {
    title: node.name || node.headline,
    // `description` is the short-summary field in the schema.org vocabulary;
    // `articleBody` is what CreativeWork/Article/SocialMediaPosting-family
    // types (Pinterest pins included) use instead for the actual text, so a
    // node with only that field would otherwise report no description at
    // all here and fall through to a weaker, page-wide source further down
    // the chain -- on an SPA that's often stale boilerplate rather than
    // anything about the specific item.
    description: node.description || node.abstract || node.articleBody,
    creator: personName(node.creator) || personName(node.artist),
    author: personName(node.author),
    publisher: personName(node.publisher),
    publication: personName(node.isPartOf) || personName(node.publisher),
    date: node.dateCreated || node.datePublished || node.temporalCoverage,
    modified_date: node.dateModified,
    medium: node.artMedium || node.material,
    collection: personName(node.isPartOf) || personName(node.collection),
    institution: personName(node.provider) || personName(node.sourceOrganization),
    keywords: node.keywords,
    doi: node.doi || node.identifier,
    caption: node.caption,
  };
}

/**
 * Schema.org people/orgs are sometimes a string, sometimes an object with a
 * `name`, sometimes an array of either.
 */
export function personName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(personName).filter(Boolean).join(", ");
  if (typeof value === "object") return normaliseValue(value.name || value["@id"] || "");
  return "";
}

/** First non-empty content for a meta tag, matched on `name` or `property`. */
export function metaContent(doc, attr, value) {
  const escaped = String(value).replace(/"/g, '\\"');
  for (const el of doc.querySelectorAll(`meta[${attr}="${escaped}"]`)) {
    const content = normaliseValue(el.getAttribute("content"));
    if (content) return content;
  }
  return "";
}
