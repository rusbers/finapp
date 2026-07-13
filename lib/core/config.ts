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
