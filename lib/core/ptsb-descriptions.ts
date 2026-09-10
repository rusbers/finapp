/**
 * AI description layer for permanent tsb (PTSB) statements. SERVER-ONLY.
 *
 * `ptsb-parser.ts` recovers PTSB's numbers deterministically — it solves the
 * anti-extraction font's digit cipher against the running-balance arithmetic, so
 * dates, amounts and balances are exact and the statement reconciles with no AI at
 * all. What it CANNOT fully recover is the Details text: the font's ToUnicode is
 * poisoned and its codes collide at glyph level, so descriptions come out as
 * fragments ("posaleapacard" for "POS SALE APPLE CARD").
 *
 * The glyphs RENDER correctly, though — the scrambling is only in the text layer —
 * so a vision model reads the page exactly as a person would. This module sends the
 * pages back through Gemini and grafts the descriptions onto the rows the parser
 * already produced.
 *
 * Two properties make this safe to run automatically:
 *
 *   1. It CANNOT affect reconciliation. It mutates `description` and nothing else;
 *      amounts, balances, dates and row order all stay exactly as the deterministic
 *      parser produced them. A row is only relabelled when the model's own reading
 *      of that row's Withdrawn/Paid In agrees TO THE CENT with what we already know
 *      — the amounts are an identity check, never data.
 *   2. It degrades instead of failing. A failed chunk, a missing API key, an
 *      unsplittable PDF or a garbled response leaves the partial descriptions in
 *      place and returns normally; the caller still has a reconciled statement.
 *
 * It runs in the route (like `categorization.ts`), never in the pipeline, so the
 * regression harness keeps testing the deterministic core with no AI calls.
 */

import type { Transaction } from "./types"
import { splitPdfIntoChunks } from "./pdf"
import { describeWithGemini, type DescribedRow } from "./gemini"
import { PAGES_PER_CHUNK, MAX_CONCURRENT_CHUNKS, DEFAULT_PRIMARY_MODEL } from "./config"

export interface PtsbDescriptionStats {
  /** Rows the layer could work on (those carrying a page number). */
  rows: number
  /** Descriptions taken from a model reading whose amounts matched the row. */
  filled: number
  /** Descriptions reused for a row the model missed, via `descriptionKey`. */
  reused: number
  chunksSent: number
  chunksFailed: number
}

/** Compare money as integer cents — the project's rule, and exact for matching. */
const cents = (n: number) => Math.round(n * 100)

/**
 * How far past the cursor we will look for the row the model is describing. The
 * model can emit a spurious row (a wrapped line read as its own row) or drop one;
 * a small window absorbs that without letting a row match something far away.
 */
const MATCH_LOOKAHEAD = 8

/** Bounded-concurrency map — mirrors the helpers in extraction.ts / categorization.ts. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) break
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * Graft one chunk's model readings onto the rows the parser produced for the same
 * pages. Both lists are in statement order, so we walk them with a single cursor and
 * pair a row only when the amounts agree to the cent.
 *
 * Exported (and pure apart from the deliberate in-place description update) so the
 * matching rules can be tested without a PDF or an API call — see
 * scripts/test-ptsb-descriptions.mts.
 */
export function graftChunk(
  detRows: Transaction[],
  aiRows: DescribedRow[],
  confirmed: Map<string, string>,
  filled: Set<Transaction>,
  stats: PtsbDescriptionStats,
): void {
  let cursor = 0
  for (const det of detRows) {
    let hit = -1
    for (let k = cursor; k < aiRows.length && k < cursor + MATCH_LOOKAHEAD; k++) {
      const ai = aiRows[k]
      if (cents(ai.withdrawn ?? 0) === cents(det.debit) && cents(ai.paidIn ?? 0) === cents(det.credit)) {
        hit = k
        break
      }
    }
    if (hit < 0) continue // model didn't read this row — keep the partial decode
    cursor = hit + 1
    const description = aiRows[hit].description
    if (!description) continue
    det.description = description
    filled.add(det)
    stats.filled++
    // Remember the reading against this row's raw glyph codes, so any other row
    // printing the same description can reuse it without another call.
    if (det.descriptionKey) confirmed.set(det.descriptionKey, description)
  }
}

/**
 * Replace PTSB descriptions with the model's reading of the rendered pages.
 * Mutates `transactions` in place and returns what it managed to do.
 */
export async function fillPtsbDescriptions(
  pdfBytes: Uint8Array,
  transactions: Transaction[],
  opts: { model?: string } = {},
): Promise<PtsbDescriptionStats> {
  const stats: PtsbDescriptionStats = { rows: 0, filled: 0, reused: 0, chunksSent: 0, chunksFailed: 0 }

  // Only rows we can locate on a page can be matched to a rendered chunk.
  const rows = transactions.filter((t) => typeof t.page === "number")
  stats.rows = rows.length
  if (rows.length === 0) return stats

  // Measured on the corpus: flash-lite and flash return the SAME descriptions here
  // (reading rendered text is not where the stronger model earns its cost), but
  // flash-lite is roughly twice as fast — 37s vs 68s on the 38-page/1394-row worst
  // case. That difference decides whether the request fits the 60s serverless budget,
  // so the fast model is the default.
  const model = opts.model ?? DEFAULT_PRIMARY_MODEL

  let chunks: string[]
  try {
    chunks = await splitPdfIntoChunks(pdfBytes, PAGES_PER_CHUNK)
  } catch {
    return stats // encrypted or unreadable by pdf-lib — keep the partial descriptions
  }

  const byPage = new Map<number, Transaction[]>()
  for (const t of rows) {
    const page = t.page as number
    const list = byPage.get(page)
    if (list) list.push(t)
    else byPage.set(page, [t])
  }

  // `splitPdfIntoChunks` keeps page order, so chunk i holds pages
  // [i*PAGES_PER_CHUNK+1 .. +PAGES_PER_CHUNK]. Chunks with no transactions on them
  // (covers, marketing pages, the summary page) are never sent.
  const jobs = chunks
    .map((pdfBase64, i) => {
      const firstPage = i * PAGES_PER_CHUNK + 1
      const chunkRows: Transaction[] = []
      for (let p = firstPage; p < firstPage + PAGES_PER_CHUNK; p++) {
        const list = byPage.get(p)
        if (list) chunkRows.push(...list)
      }
      return { pdfBase64, chunkRows }
    })
    .filter((job) => job.chunkRows.length > 0)

  stats.chunksSent = jobs.length
  if (jobs.length === 0) return stats

  const readings = await mapWithLimit(jobs, MAX_CONCURRENT_CHUNKS, async (job) => {
    try {
      return await describeWithGemini(job.pdfBase64, model)
    } catch {
      return null // one bad chunk must not lose the whole statement's descriptions
    }
  })

  const confirmed = new Map<string, string>()
  const filled = new Set<Transaction>()
  readings.forEach((aiRows, i) => {
    if (!aiRows) {
      stats.chunksFailed++
      return
    }
    graftChunk(jobs[i].chunkRows, aiRows, confirmed, filled, stats)
  })

  // A row the model skipped can still be recovered when the SAME description was
  // confirmed on another row: identical glyph codes mean identical printed text.
  for (const t of rows) {
    if (filled.has(t) || !t.descriptionKey) continue
    const known = confirmed.get(t.descriptionKey)
    if (!known) continue
    t.description = known
    stats.reused++
  }

  return stats
}
