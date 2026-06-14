/**
 * Extract-and-reconcile pipeline — the cascade.
 *
 * Flow:
 *   1. Try the primary model. Run reconciliation.
 *   2. If it passed → done.
 *   3. If it failed AND fallback is enabled → try the fallback model, reconcile again.
 *   4. Return the best result + a record of every attempt (for stats).
 *
 * Options come from the caller (the web UI passes user choices). When an option
 * is omitted, the defaults from config.ts are used (e.g. for a future API).
 */

import type {
  StatementData,
  ReconciliationResult,
  ExtractionAttempt,
  PipelineResult,
} from "./types"
import { extractStatement } from "./extraction"
import { checkReconciliation } from "./reconciliation"
import { DEFAULT_ENABLE_FALLBACK, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL } from "./config"

export interface PipelineOptions {
  primaryModel?: string
  fallbackModel?: string
  enableFallback?: boolean
}

export async function extractAndReconcile(
  pdfBase64: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const primaryModel = options.primaryModel ?? DEFAULT_PRIMARY_MODEL
  const fallbackModel = options.fallbackModel ?? DEFAULT_FALLBACK_MODEL
  const enableFallback = options.enableFallback ?? DEFAULT_ENABLE_FALLBACK

  // Which models to try, in order. Without fallback, just the primary one.
  // (If fallback equals primary, no point trying twice — keep just one.)
  const models =
    enableFallback && fallbackModel !== primaryModel
      ? [primaryModel, fallbackModel]
      : [primaryModel]

  const attempts: ExtractionAttempt[] = []
  let last: {
    data: StatementData
    reconciliation: ReconciliationResult
    model: string
  } | null = null

  for (const model of models) {
    const startedAt = Date.now()
    const data = await extractStatement(pdfBase64, model)
    const reconciliation = checkReconciliation(data)
    const durationMs = Date.now() - startedAt

    attempts.push({
      model,
      reconciliationPassed: reconciliation.passed,
      discrepancyCents: reconciliation.discrepancyCents,
      durationMs,
    })
    last = { data, reconciliation, model }

    // Stop as soon as one model reconciles successfully.
    if (reconciliation.passed) break
  }

  if (!last) throw new Error("No extraction attempts ran")

  return {
    data: last.data,
    reconciliation: last.reconciliation,
    attempts,
    modelUsed: last.model,
    fallbackUsed: attempts.length > 1,
  }
}
