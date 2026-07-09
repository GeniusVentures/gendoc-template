/**
 * Shared contract between the ask-worker and the site widget.
 *
 * The worker streams Server-Sent Events; each `data:` payload is one
 * JSON-encoded {@link SseEvent}. Event order per request:
 *
 *   1. { sources } -- exactly once, may be an empty array
 *   2. { thinking }-- zero or more reasoning deltas (collapsible by UI)
 *   3. { text }    -- zero or more incremental answer deltas
 *   4. { done }    -- exactly once, terminal
 *
 * If/when ask-worker migrates to TypeScript it should import these types
 * so the two sides cannot drift.
 */
export {};
