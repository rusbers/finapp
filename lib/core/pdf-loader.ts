/**
 * Lazy loader for pdfjs-dist.
 *
 * pdfjs is imported DYNAMICALLY (not at module top-level) so it only loads when a
 * deterministic parser actually runs. This keeps it off the AI/generic path
 * entirely, and isolates pdfjs's ESM/worker quirks to the moment of use — which
 * matters on serverless (Vercel), where a top-level ESM import of pdfjs can fail
 * to initialize even when it works locally.
 *
 * We intentionally do NOT set GlobalWorkerOptions.workerSrc: pdfjs-dist v6 is
 * ESM, so require()-resolving the worker path breaks under Next.js. Leaving it
 * unset uses pdfjs's built-in main-thread fallback, which is correct on the
 * server. (Server-only — never import a parser into client code.)
 *
 * The module is cached after the first load so repeated calls are cheap.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any

let cached: PdfjsModule | null = null

export async function loadPdfjs(): Promise<PdfjsModule> {
  if (cached) return cached
  cached = await import("pdfjs-dist/legacy/build/pdf.mjs")
  return cached
}
