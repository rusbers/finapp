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
import {
  DESCRIBE_PAGES_PER_CHUNK,
  DESCRIBE_CONCURRENCY,
  DESCRIBE_RETRY_MIN_FILL,
  DESCRIBE_RETRY_DEADLINE_MS,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
} from "./config"

export interface PtsbDescriptionStats {
  /** Rows the layer could work on (those carrying a page number). */
  rows: number
  /** Descriptions taken from a model reading whose amounts matched the row. */
  filled: number
  /** Descriptions reused for a row the model missed, via `descriptionKey`. */
  reused: number
  chunksSent: number
  chunksFailed: number
  /** Chunks re-read by the stronger model because the fast one read them poorly. */
  chunksRetried: number
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

/** One PDF plus the rows the deterministic parser produced from it. */
export interface PtsbDocument {
  bytes: Uint8Array
  transactions: Transaction[]
}

/**
 * Replace PTSB descriptions with the model's reading of the rendered pages.
 * Mutates the transactions in place and returns what it managed to do.
 *
 * Takes ALL the documents of a request at once (a user often uploads a year as
 * several PDFs, and a client can hold more than one PTSB account) so that every page
 * of every file competes for ONE concurrency budget. Reading each file in turn would
 * finish each one quickly and still add up past the serverless limit.
 */
export async function fillPtsbDescriptions(
  docs: PtsbDocument[],
  opts: { model?: string } = {},
): Promise<PtsbDescriptionStats> {
  const startedAt = Date.now()
  const stats: PtsbDescriptionStats = {
    rows: 0,
    filled: 0,
    reused: 0,
    chunksSent: 0,
    chunksFailed: 0,
    chunksRetried: 0,
  }

  // Measured on the corpus: flash-lite and flash return the SAME descriptions here
  // (reading rendered text is not where the stronger model earns its cost), but
  // flash-lite is roughly twice as fast — which is what decides whether the request
  // fits the 60s serverless budget. So the fast model is the default, and the chunks
  // it gets wrong are escalated below.
  const model = opts.model ?? DEFAULT_PRIMARY_MODEL

  /** A slice of pages to read, and the rows it should explain. */
  interface Job {
    doc: number
    /** First page of the slice, 1-based — used to re-read it page by page on a retry. */
    firstPage: number
    pages: number
    pdfBase64: string
    chunkRows: Transaction[]
  }
  const jobs: Job[] = []
  // Per document: its rows in statement order, and those rows grouped by page. Both
  // are needed again after the first pass (the retry and the reuse walk them).
  const docRows: Transaction[][] = []
  const docPages: Map<number, Transaction[]>[] = []

  for (let d = 0; d < docs.length; d++) {
    // Only rows we can locate on a page can be matched to a rendered chunk.
    const rows = docs[d].transactions.filter((t) => typeof t.page === "number")
    const byPage = new Map<number, Transaction[]>()
    docRows.push(rows)
    docPages.push(byPage)
    stats.rows += rows.length
    if (rows.length === 0) continue

    let chunks: string[]
    try {
      chunks = await splitPdfIntoChunks(docs[d].bytes, DESCRIBE_PAGES_PER_CHUNK)
    } catch {
      continue // encrypted or unreadable by pdf-lib — keep this file's partial descriptions
    }

    for (const t of rows) {
      const page = t.page as number
      const list = byPage.get(page)
      if (list) list.push(t)
      else byPage.set(page, [t])
    }

    // `splitPdfIntoChunks` keeps page order, so chunk i holds pages
    // [i*N+1 .. i*N+N]. Chunks with no transactions on them (covers, marketing
    // pages, the summary page) are never sent.
    for (let i = 0; i < chunks.length; i++) {
      const firstPage = i * DESCRIBE_PAGES_PER_CHUNK + 1
      const chunkRows: Transaction[] = []
      for (let p = firstPage; p < firstPage + DESCRIBE_PAGES_PER_CHUNK; p++) {
        const list = byPage.get(p)
        if (list) chunkRows.push(...list)
      }
      if (chunkRows.length > 0) {
        jobs.push({ doc: d, firstPage, pages: DESCRIBE_PAGES_PER_CHUNK, pdfBase64: chunks[i], chunkRows })
      }
    }
  }

  stats.chunksSent = jobs.length
  if (jobs.length === 0) return stats

  const readings = await mapWithLimit(jobs, DESCRIBE_CONCURRENCY, async (job) => {
    try {
      return await describeWithGemini(job.pdfBase64, model)
    } catch {
      return null // one bad chunk must not lose the whole statement's descriptions
    }
  })

  // `confirmed` is kept PER DOCUMENT: the key is the row's raw glyph codes, and the
  // font is subsetted per PDF, so the same codes in another file are not guaranteed
  // to print the same text. Reuse stays inside the document that proved it.
  const confirmed = docs.map(() => new Map<string, string>())
  const filled = new Set<Transaction>()
  readings.forEach((aiRows, i) => {
    if (!aiRows) {
      stats.chunksFailed++
      return
    }
    graftChunk(jobs[i].chunkRows, aiRows, confirmed[jobs[i].doc], filled, stats)
  })

  await retryPoorChunks(docs, jobs, readings, docPages, confirmed, filled, stats, startedAt)

  // Rows can be grafted twice (first pass, then a retry), so take the count from the
  // set of rows actually relabelled rather than from the number of grafts.
  stats.filled = filled.size

  // A row the model skipped can still be recovered when the SAME description was
  // confirmed on another row: identical glyph codes mean identical printed text.
  for (let d = 0; d < docRows.length; d++) {
    for (const t of docRows[d]) {
      if (filled.has(t) || !t.descriptionKey) continue
      const known = confirmed[d].get(t.descriptionKey)
      if (!known) continue
      t.description = known
      stats.reused++
    }
  }

  return stats
}

/**
 * Second pass: re-read the slices the fast model got wrong, with the stronger model.
 *
 * The failure is not random, so simply repeating the same call is pointless: flash-lite
 * occasionally reads a wrapped line as an extra row, and from there its reading runs
 * out of step with the parser's rows, so the rest of the slice matches nothing.
 * Measured on a real 3-page block, it returned 116 rows for 106 and matched only 24 —
 * identically on a repeat, while flash returned 106 and matched all of them.
 *
 * Two things fix it and the retry uses both: the stronger model, and a smaller slice.
 * With the default of one page per call the slice is already minimal, so the retry
 * re-sends it as it is; a larger DESCRIBE_PAGES_PER_CHUNK is broken down page by page,
 * which both bounds the drift and keeps the calls short enough to run together (that
 * same 3-page block: 106/106 in ~9s page-by-page, against ~20s as one call).
 *
 * Only the slices that came back poor pay for this, and the pass is skipped once the
 * request is too far along to afford it — partial descriptions on a reconciled
 * statement are the fail-soft outcome; a serverless timeout is not.
 */
async function retryPoorChunks(
  docs: PtsbDocument[],
  jobs: { doc: number; firstPage: number; pages: number; pdfBase64: string; chunkRows: Transaction[] }[],
  readings: (DescribedRow[] | null)[],
  docPages: Map<number, Transaction[]>[],
  confirmed: Map<string, string>[],
  filled: Set<Transaction>,
  stats: PtsbDescriptionStats,
  startedAt: number,
): Promise<void> {
  const poor = jobs.filter((job, i) => {
    if (!readings[i]) return true // transport failure — nothing was read at all
    const hits = job.chunkRows.filter((t) => filled.has(t)).length
    return hits < job.chunkRows.length * DESCRIBE_RETRY_MIN_FILL
  })
  if (poor.length === 0 || Date.now() - startedAt >= DESCRIBE_RETRY_DEADLINE_MS) return

  const retryJobs: { doc: number; pdfBase64: string; rows: Transaction[] }[] = []
  // Only needed when a slice covers several pages; split each such document once.
  const singlePages = new Map<number, string[]>()
  for (const job of poor) {
    if (job.pages === 1) {
      retryJobs.push({ doc: job.doc, pdfBase64: job.pdfBase64, rows: job.chunkRows })
      continue
    }
    let pages = singlePages.get(job.doc)
    if (!pages) {
      try {
        pages = await splitPdfIntoChunks(docs[job.doc].bytes, 1)
      } catch {
        continue // it split once already; if it fails now, keep what we have
      }
      singlePages.set(job.doc, pages)
    }
    for (let p = job.firstPage; p < job.firstPage + job.pages; p++) {
      const rows = docPages[job.doc].get(p)
      if (rows && pages[p - 1]) retryJobs.push({ doc: job.doc, pdfBase64: pages[p - 1], rows })
    }
  }
  if (retryJobs.length === 0) return

  stats.chunksRetried = retryJobs.length
  const retries = await mapWithLimit(retryJobs, DESCRIBE_CONCURRENCY, async (job) => {
    try {
      return await describeWithGemini(job.pdfBase64, DEFAULT_FALLBACK_MODEL)
    } catch {
      return null
    }
  })
  retries.forEach((aiRows, k) => {
    if (!aiRows) return
    graftChunk(retryJobs[k].rows, aiRows, confirmed[retryJobs[k].doc], filled, stats)
  })
}
