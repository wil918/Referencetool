/* What this copy of the app is configured to do.
 *
 * The answers come from the server (GET /capabilities.js, a classic script each
 * page loads synchronously in its <head> -- the same trick theme.js uses so
 * there is no flash of the wrong thing). It sets window.capabilities and marks
 * <html data-schedule/claude/embeddings="off"> for whatever is off, and does
 * nothing at all when everything is on, so an install with every capability
 * keeps behaving exactly as it did before they existed.
 *
 *   schedule    -- the planner is mounted (config.ARCHIVE_ONLY is unset)
 *   claude      -- an ANTHROPIC_API_KEY is configured
 *   embeddings  -- the CLIP model and vector store are in use
 *
 * Two ways to use it, and which one is a matter of how the control is made:
 *
 *   - Markup that already exists in an HTML page carries data-requires="claude"
 *     (or schedule / embeddings) and style.css hides it while that capability
 *     is off. Hidden, not disabled: a greyed-out control advertises something
 *     the person cannot have. It is hidden with CSS rather than removed because
 *     the module that owns it may already be holding a reference to it.
 *   - Controls a module builds itself check `capabilities.claude` and simply do
 *     not build them.
 *
 * What initiates a Claude call is hidden; what only *reads* a stored result is
 * kept -- a saved analysis is a row in the database and viewing it costs
 * nothing, and losing sight of it because a key lapsed would be worse than the
 * absence of a button.
 *
 * If the script did not load (a page that forgot it), everything defaults to
 * on, which is the app as it was.
 */

const DEFAULTS = { schedule: true, claude: true, embeddings: true };

export const capabilities = Object.freeze({ ...DEFAULTS, ...(globalThis.capabilities || {}) });

/** True if every capability in `names` is on. */
export function hasAll(names = [], caps = capabilities) {
  return names.every((name) => caps[name]);
}
