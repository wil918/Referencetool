/**
 * Pinterest.
 *
 * Earns an adapter because of one thing the generic extractor cannot get
 * right: a pin is almost never the origin of the image. It's a re-post that
 * usually credits where it came from -- a museum, a magazine, a designer's
 * own site. Saving only the Pinterest URL loses the actual source; replacing
 * it with the credited one loses where you found it. Both are kept.
 *
 * The credited link is recorded as a *claim*, not a fact. Pinterest source
 * links are frequently dead, wrong, or point at an aggregator that reposted
 * it in turn, so it never overwrites the immediate source.
 */
import * as generic from "./generic.js";

export const id = "pinterest";

export function matches(host) {
  return host === "pinterest.com" || host.endsWith(".pinterest.com");
}

export function extract(doc = document, win = window) {
  const result = generic.extract(doc, win);
  const original = creditedSource(doc, win);

  if (original) {
    result.source = {
      ...result.source,
      // The chain, immediate first. The backend stores the whole envelope, so
      // both survive; nothing here overwrites source.url.
      original_source_url: original.url,
      original_source_domain: original.domain,
      original_source_claimed_by: "pinterest",
    };
  }
  return result;
}

export const mergeForImage = generic.mergeForImage;

/**
 * The outbound link a pin credits as its source.
 *
 * Matched structurally (an external link on a pin page) rather than by
 * class name, since Pinterest's generated class names change constantly.
 */
export function creditedSource(doc = document, win = window) {
  const here = (win.location?.hostname || "").replace(/^www\./, "");

  const links = [
    ...doc.querySelectorAll('a[href^="http"][target="_blank"], a[data-test-id*="source"]'),
  ];

  for (const link of links) {
    let url;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    const domain = url.hostname.replace(/^www\./, "");
    if (!domain || domain === here || domain.endsWith("pinterest.com")) continue;
    // Skip the share/auth links every page carries.
    if (/^(facebook|twitter|x|instagram|accounts\.google)\./.test(domain)) continue;
    return { url: url.href, domain };
  }
  return null;
}
