/**
 * Extraction orchestrator.
 *
 * For a given model, this:
 *   1. Splits the PDF into small page-chunks (config: PAGES_PER_CHUNK).
 *   2. Extracts all chunks IN PARALLEL (config: MAX_CONCURRENT_CHUNKS).
 *   3. Merges the chunks back into one statement.
 *
 * This is the provider-agnostic seam: to switch AI provider, change the call to
 * extractWithGemini below (and add the new provider file). Splitting/merging is
 * provider-independent.
 */

import type { StatementData, ExtractedChunk } from "./types"
import { extractWithGemini } from "./gemini"
import { splitPdfIntoChunks } from "./pdf"
import { PAGES_PER_CHUNK, MAX_CONCURRENT_CHUNKS } from "./config"

/**
 * Run an async function over items with a concurrency limit.
 * Preserves input order in the results array.
 */
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

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/**
 * Merge per-chunk results (in page order) into one statement.
 * - transactions: concatenated in order
 * - openingBalance: from the first chunk that reports one (page 1 of the full
 *   statement); falls back to deriving it from the first transaction's running
 *   balance if no chunk reported it.
 * - closingBalance: from the last chunk that reports one (last page); falls back
 *   to the last transaction's running balance.
 */
export function mergeChunks(chunks: ExtractedChunk[]): StatementData {
  const transactions = chunks.flatMap((c) => c.transactions ?? [])
  const bank = chunks.find((c) => c.bank)?.bank ?? ""

  // Opening: first chunk holds page 1, so its openingBalance is the real one.
  let openingBalance: number | null =
    chunks.find((c) => c.openingBalance != null)?.openingBalance ?? null
  if (openingBalance == null && transactions.length > 0) {
    const first = transactions[0]
    if (first.balance != null) {
      // running balance after first tx, minus its effect = opening balance
      openingBalance = first.balance - (first.credit ?? 0) + (first.debit ?? 0)
    }
  }

  // Closing: last chunk holds the last page, so its closingBalance is the real one.
  let closingBalance: number | null = null
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].closingBalance != null) {
      closingBalance = chunks[i].closingBalance
      break
    }
  }
  if (closingBalance == null && transactions.length > 0) {
    const last = transactions[transactions.length - 1]
    if (last.balance != null) closingBalance = last.balance
  }

  return {
    bank,
    openingBalance: openingBalance ?? 0,
    closingBalance: closingBalance ?? 0,
    transactions,
  }
}

/**
 * Extract a full statement from PDF bytes using the given model:
 * split → parallel extract → merge.
 */
export async function extractStatement(
  pdfBytes: Uint8Array,
  model: string,
): Promise<StatementData> {
  const chunks = await splitPdfIntoChunks(pdfBytes, PAGES_PER_CHUNK)
  const extracted = await mapWithLimit(chunks, MAX_CONCURRENT_CHUNKS, (chunkBase64) =>
    extractWithGemini(chunkBase64, model),
  )
  return mergeChunks(extracted)
}
