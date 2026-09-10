/**
 * Pipeline configuration — DEFAULTS.
 *
 * These are the defaults used when the caller doesn't specify options (e.g. a
 * future public API with no UI). The web UI can override them per request.
 *
 * ENABLE_FALLBACK: when true, if the primary (cheap) model fails reconciliation,
 * the pipeline retries with a stronger model. Useful in TESTING to maximize the
 * success rate and gather stats. Off by default to control cost.
 */
export const DEFAULT_ENABLE_FALLBACK = false

export const DEFAULT_PRIMARY_MODEL = "gemini-2.5-flash-lite" // cheapest + fastest
export const DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash" // strongest remaining (Pro removed)

/**
 * PDF chunking — large statements are split into small page-chunks that are
 * extracted in parallel, then merged. Keeps each AI call small (fast, under the
 * serverless time limit). The client never sees this; they upload one file.
 */
export const PAGES_PER_CHUNK = 3 // pages per parallel chunk
export const MAX_CONCURRENT_CHUNKS = 8 // how many chunks to run at once
// (With API billing enabled, MAX_CONCURRENT_CHUNKS can be raised for more speed.
//  On the free tier, keep it modest to avoid rate-limit (429) errors.)

/**
 * PTSB DESCRIPTION layer (ptsb-descriptions.ts) — its own chunking, because it is the
 * ONE AI step that is always on, and its wall time is what decides whether a large
 * statement fits the 60s serverless budget.
 *
 * ONE page per call, and three times the parallelism of the extraction path. A page is
 * the smallest slice that still shows the model a whole table, and a small slice is
 * better on both axes: the calls are short enough that even a big statement finishes
 * in one or two waves, and a misreading is contained — the model occasionally reads a
 * wrapped line as an extra row, and from there its reading runs out of step with the
 * parser's rows, losing the REST of the slice (see `retryPoorChunks`).
 *
 * Measured end to end on the 38-page/1394-row worst case, filled rows out of 1394:
 *   3 pages / concurrency 8  → ~29s   (2 waves)   — the previous setting, no retries
 *   3 pages / concurrency 16 → ~24s   (1 wave)    1390 filled, 3 pages re-read
 *   1 page  / concurrency 24 → ~20s   (2 waves)   1393 filled, 1 page re-read
 *   1 page  / concurrency 48 → ~17s   (1 wave)    1393 filled, 1 page re-read
 *
 * Concurrency 24 is the setting: beyond it the wall time barely moves (the key's
 * throughput, not the parallelism, is the limit — per-call latency rises as fast as
 * the wave count falls) while the rate-limit exposure keeps growing. On a free-tier
 * key, lower it: 429s are retried with backoff, which costs more time than the
 * parallelism saves.
 *
 * The remaining ceiling is throughput, roughly 80 rows/second on this key, so a
 * statement of a few thousand rows is the practical limit of a single request. Past
 * that the fix is structural (read the descriptions from a second request, or raise
 * the function's maxDuration), not a bigger number here.
 */
export const DESCRIBE_PAGES_PER_CHUNK = 1
export const DESCRIBE_CONCURRENCY = 24

/**
 * A chunk that comes back with fewer than this share of its rows recognised was not
 * read properly — the fast model sometimes splits wrapped lines into extra rows and
 * desynchronises against the parser's rows. Measured, good chunks land at 98-100% and
 * a bad one at ~28%, so the threshold is not delicate.
 */
export const DESCRIBE_RETRY_MIN_FILL = 0.9

/**
 * How long into the description pass we may still START a retry wave. The retry uses
 * the stronger (slower) model, so it must not be launched when the request no longer
 * has room for it: this layer is fail-soft, and partial descriptions on a reconciled
 * statement beat a serverless timeout. Sized against `maxDuration = 60` in the extract
 * route, leaving headroom for the retry wave plus the response.
 */
export const DESCRIBE_RETRY_DEADLINE_MS = 30_000

/**
 * The only model names the backend will accept (allow-list).
 * Prevents arbitrary/unsupported model names from being sent via the API.
 */
export const ALLOWED_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
] as const

export type AllowedModel = (typeof ALLOWED_MODELS)[number]

/** Type guard: is this string one of the allowed models? */
export function isAllowedModel(value: unknown): value is AllowedModel {
  return typeof value === "string" && (ALLOWED_MODELS as readonly string[]).includes(value)
}
