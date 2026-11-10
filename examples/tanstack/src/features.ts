/**
 * The one feature id the Worker and the page share.
 *
 * An id is a name, not a plan term: the catalog imports it to declare the
 * feature, and the page imports it to name the feature in a request. The
 * catalog itself stays server-only, so a plan's price or grants still cannot go
 * stale in the browser — and the page cannot disagree with the catalog about
 * what the feature is called.
 */
export const MESSAGES = "messages";
