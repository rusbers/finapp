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
import { combineStatements, type StatementGap } from "./combine"
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

/** Per-file outcome inside a multi-PDF run (for transparency in the UI). */
export interface PerFileResult {
  fileName: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
}

/** Result of processing several PDFs as one chained series. */
export interface MultiPipelineResult {
  /** The combined, chained statement plus its reconciliation/trace. */
  result: PipelineResult
  /** Each input file's contribution, in the resolved chain order. */
  perFile: PerFileResult[]
  /** Gaps between statements (a missing statement breaks the balance chain). */
  gaps: StatementGap[]
  /** True if all files linked into one clean balance chain with no gaps. */
  fullyChained: boolean
}

/**
 * Process several PDFs of the same account and combine them into one
 * chronological, balance-chained series, then reconcile across the whole set.
 *
 * Each file is parsed independently (deterministic parser or AI), then
 * `combineStatements` orders them by linking each statement's closing balance to
 * the next one's opening balance, flags any gaps (missing statements), and
 * concatenates the transactions in chain order (internal order untouched). The
 * final reconciliation runs over the combined series: first opening + Σcredits −
 * Σdebits = last closing, which also confirms the statements chain correctly.
 */
export async function extractAndReconcileMany(
  files: { name: string; bytes: Uint8Array }[],
  options: PipelineOptions = {},
): Promise<MultiPipelineResult> {
  if (files.length === 0) throw new Error("No files provided")

  // 1. Parse each file independently, keeping its statement + file name.
  const perFileRaw: { name: string; statement: StatementData }[] = []
  for (const file of files) {
    const r = await extractAndReconcile(file.bytes, options)
    perFileRaw.push({ name: file.name, statement: r.data })
  }

  // 2. Chain + merge them (orders by balance, detects gaps).
  const { combined, gaps, fullyChained } = combineStatements(perFileRaw.map((p) => p.statement))

  // 3. Reconcile the combined series, with the same sign-correction + 0-tx guard
  // used for a single statement.
  const { data, corrections } = correctSignsFromBalance(combined)
  let reconciliation = checkReconciliation(data)
  if (data.transactions.length === 0) {
    reconciliation = { ...reconciliation, passed: false }
  }

  // 4. Build the per-file summary in the resolved chain order. (We match each
  // chained statement back to its file by identity.)
  const perFile: PerFileResult[] = perFileRaw.map((p) => ({
    fileName: p.name,
    transactionCount: p.statement.transactions.length,
    openingBalance: p.statement.openingBalance,
    closingBalance: p.statement.closingBalance,
  }))

  const result: PipelineResult = {
    data,
    reconciliation,
    attempts: [
      {
        model: `combined:${files.length}-files`,
        reconciliationPassed: reconciliation.passed,
        discrepancyCents: reconciliation.discrepancyCents,
        durationMs: 0,
      },
    ],
    modelUsed: `combined:${files.length}-files`,
    fallbackUsed: false,
    corrections,
  }

  return { result, perFile, gaps, fullyChained }
}
