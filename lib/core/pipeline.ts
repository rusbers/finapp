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
  SignCorrection,
} from "./types"
import { extractStatement } from "./extraction"
import { checkReconciliation } from "./reconciliation"
import { correctSignsFromBalance } from "./sign-correction"
import { getPrompt, type BankId } from "./prompts"
import { getParser } from "./parsers"
import { DEFAULT_ENABLE_FALLBACK, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL } from "./config"

export interface PipelineOptions {
  primaryModel?: string
  fallbackModel?: string
  enableFallback?: boolean
  bank?: BankId // which bank's specialized prompt to use (default "generic")
}

export async function extractAndReconcile(
  pdfBytes: Uint8Array,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const primaryModel = options.primaryModel ?? DEFAULT_PRIMARY_MODEL
  const fallbackModel = options.fallbackModel ?? DEFAULT_FALLBACK_MODEL
  const enableFallback = options.enableFallback ?? DEFAULT_ENABLE_FALLBACK
  const bank: BankId = options.bank ?? "generic"

  // --- Deterministic parser path ---
  // If this bank has a deterministic parser, use it instead of AI: it's 100%
  // accurate and consistent on the bank's fixed layout, and far faster/cheaper.
  // We still run sign-correction and reconciliation so the output shape and the
  // completeness guarantee are identical to the AI path.
  const parser = getParser(bank)
  if (parser) {
    const startedAt = Date.now()
    const parsed = await parser(pdfBytes)
    const { data, corrections } = correctSignsFromBalance(parsed)
    let reconciliation = checkReconciliation(data)
    const durationMs = Date.now() - startedAt

    // Guard: if the parser found NO transactions, the layout wasn't recognized
    // (e.g. a different statement language/format). Zero-vs-zero would otherwise
    // look like a (false) successful reconciliation, so mark it as NOT passed.
    if (data.transactions.length === 0) {
      reconciliation = { ...reconciliation, passed: false }
    }

    return {
      data,
      reconciliation,
      attempts: [
        {
          model: `parser:${bank}`,
          reconciliationPassed: reconciliation.passed,
          discrepancyCents: reconciliation.discrepancyCents,
          durationMs,
        },
      ],
      modelUsed: `parser:${bank}`,
      fallbackUsed: false,
      corrections,
    }
  }

  // --- AI extraction path (banks without a deterministic parser) ---
  const prompt = getPrompt(bank)

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
    corrections: SignCorrection[]
  } | null = null

  for (const model of models) {
    const startedAt = Date.now()
    const extracted = await extractStatement(pdfBytes, model, prompt)

    // Auto-correct debit/credit using the running balance (only where certain),
    // BEFORE reconciling — so corrected data is what we reconcile and return.
    const { data, corrections } = correctSignsFromBalance(extracted)

    const reconciliation = checkReconciliation(data)
    const durationMs = Date.now() - startedAt

    attempts.push({
      model,
      reconciliationPassed: reconciliation.passed,
      discrepancyCents: reconciliation.discrepancyCents,
      durationMs,
    })
    last = { data, reconciliation, model, corrections }

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
    corrections: last.corrections,
  }
}
