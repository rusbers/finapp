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
  Transaction,
} from "./types"
import { extractStatement } from "./extraction"
import { checkReconciliation } from "./reconciliation"
import { correctSignsFromBalance } from "./sign-correction"
import { getPrompt, type BankId } from "./prompts"
import { getParser } from "./parsers"
import { parseRevolutConsolidated } from "./revolut-consolidated-parser"
import { parseRevolutAccounts } from "./revolut-parser"
import { combineStatements, type StatementGap } from "./combine"
import { DEFAULT_ENABLE_FALLBACK, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL } from "./config"

export interface PipelineOptions {
  primaryModel?: string
  fallbackModel?: string
  enableFallback?: boolean
  bank?: BankId // which bank's specialized prompt to use (default "generic")
  /**
   * When a deterministic parser yields ZERO transactions (an unreadable layout —
   * a scanned PDF, or an anti-extraction font like PTSB's), fall back to AI vision
   * instead of returning an empty result. Default true (the app). The regression
   * harness passes false so it stays deterministic and makes no AI calls.
   */
  allowAiFallback?: boolean
}

export async function extractAndReconcile(
  pdfBytes: Uint8Array,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const primaryModel = options.primaryModel ?? DEFAULT_PRIMARY_MODEL
  const fallbackModel = options.fallbackModel ?? DEFAULT_FALLBACK_MODEL
  const enableFallback = options.enableFallback ?? DEFAULT_ENABLE_FALLBACK
  const bank: BankId = options.bank ?? "generic"
  const allowAiFallback = options.allowAiFallback ?? true

  // --- Deterministic parser path ---
  // If this bank has a deterministic parser, use it instead of AI: it's 100%
  // accurate and consistent on the bank's fixed layout, and far faster/cheaper.
  // We still run sign-correction and reconciliation so the output shape and the
  // completeness guarantee are identical to the AI path.
  const parser = getParser(bank)
  // If the parser ran but found nothing, we remember the attempt so the AI
  // fallback's trace shows the parser was tried first.
  let parserAttempt: ExtractionAttempt | null = null
  if (parser) {
    const startedAt = Date.now()
    const parsed = await parser(pdfBytes)
    const durationMs = Date.now() - startedAt

    if (parsed.transactions.length > 0) {
      const { data, corrections } = correctSignsFromBalance(parsed)
      const reconciliation = checkReconciliation(data)
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

    // Zero transactions can mean two very different things. Distinguish them:
    //
    //  (a) A readable statement with NO activity (e.g. a dormant month): the
    //      parser DID read a real opening/closing balance, there are simply no
    //      postings. If it reconciles (opening == closing) and a real balance was
    //      read (not the 0/0 default), it's a valid empty statement — return it as
    //      a pass rather than wastefully falling back to AI (which would also find
    //      nothing, or fail on an encrypted PDF).
    //  (b) An unreadable layout (a scanned PDF, or an anti-extraction font like
    //      PTSB's): the parser found nothing at all → opening/closing default to 0.
    //      Fall through to AI vision below, which reads the rendered page.
    const emptyRecon = checkReconciliation(parsed)
    const readARealBalance = parsed.openingBalance !== 0 || parsed.closingBalance !== 0
    if (emptyRecon.passed && readARealBalance) {
      return {
        data: parsed,
        reconciliation: emptyRecon,
        attempts: [
          {
            model: `parser:${bank}`,
            reconciliationPassed: emptyRecon.passed,
            discrepancyCents: emptyRecon.discrepancyCents,
            durationMs,
          },
        ],
        modelUsed: `parser:${bank}`,
        fallbackUsed: false,
        corrections: [],
      }
    }

    // Case (b): record the attempt; then, if allowed, fall through to AI vision.
    parserAttempt = { model: `parser:${bank}`, reconciliationPassed: false, discrepancyCents: 0, durationMs }

    if (!allowAiFallback) {
      // Deterministic-only (e.g. the regression harness): return the empty result
      // marked NOT passed; never make an AI call.
      const { data, corrections } = correctSignsFromBalance(parsed)
      const reconciliation = { ...checkReconciliation(data), passed: false }
      return {
        data,
        reconciliation,
        attempts: [parserAttempt],
        modelUsed: `parser:${bank}`,
        fallbackUsed: false,
        corrections,
      }
    }
    // else: fall through to the AI extraction path below.
  }

  // --- AI extraction path (banks without a parser, or parser fell back here) ---
  const prompt = getPrompt(bank)

  // Which models to try, in order. Without fallback, just the primary one.
  // (If fallback equals primary, no point trying twice — keep just one.)
  const models =
    enableFallback && fallbackModel !== primaryModel
      ? [primaryModel, fallbackModel]
      : [primaryModel]

  // Seed with the (empty) parser attempt when we fell back from it, so the trace
  // shows parser → AI and `fallbackUsed` reflects it.
  const attempts: ExtractionAttempt[] = parserAttempt ? [parserAttempt] : []
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
  /** Covered period (ISO dates, min/max of the file's transactions), if known. */
  periodStart: string | null
  periodEnd: string | null
}

/** A statement that duplicates another already-uploaded one (same content, often a
 * different file name) — ignored from the combined series, reported to the user. */
export interface DuplicateStatement {
  fileName: string // the ignored copy
  duplicateOf: string // the file it is identical to (the one we kept)
  transactionCount: number
  periodStart: string | null
  periodEnd: string | null
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
  /** Files that duplicate another upload (same content) — excluded from the series. */
  duplicates: DuplicateStatement[]
}

/** A content fingerprint of a statement: same parsed content → same key, regardless
 * of the file name (so a duplicate uploaded under a different name still matches). */
function contentKey(s: StatementData): string {
  return JSON.stringify([
    Math.round(s.openingBalance * 100),
    Math.round(s.closingBalance * 100),
    s.transactions.map((t) => [t.date, t.description, t.debit, t.credit, t.balance]),
  ])
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

  // 1. Parse each file independently, keeping its statement + file name. Tag every
  // row with its source file so the combined table/CSV can show where it came from
  // (the page is already set per row by the deterministic parser).
  const perFileRaw: { name: string; statement: StatementData }[] = []
  for (const file of files) {
    const r = await extractAndReconcile(file.bytes, options)
    const statement: StatementData = {
      ...r.data,
      transactions: r.data.transactions.map((t) => ({ ...t, sourceFile: file.name })),
    }
    perFileRaw.push({ name: file.name, statement })
  }

  // 2. Drop exact-content duplicates (the same statement uploaded twice, often under a
  // different name). Keep the first occurrence; report the rest. Two identical
  // statements share opening AND closing, so they don't chain — leaving them in would
  // double the transactions and show a false gap. Only statements WITH transactions
  // are considered (so two genuinely empty months with the same balance aren't flagged).
  const seen = new Map<string, string>() // content key → first file name
  const uniqueRaw: typeof perFileRaw = []
  const duplicates: DuplicateStatement[] = []
  for (const p of perFileRaw) {
    const key = contentKey(p.statement)
    const firstName = p.statement.transactions.length > 0 ? seen.get(key) : undefined
    if (firstName) {
      const dates = p.statement.transactions.map((t) => t.date).filter((d): d is string => !!d).sort()
      duplicates.push({
        fileName: p.name,
        duplicateOf: firstName,
        transactionCount: p.statement.transactions.length,
        periodStart: dates[0] ?? null,
        periodEnd: dates[dates.length - 1] ?? null,
      })
    } else {
      if (p.statement.transactions.length > 0) seen.set(key, p.name)
      uniqueRaw.push(p)
    }
  }

  // 3. Chain + merge the UNIQUE statements (orders by balance, detects gaps).
  const { combined, gaps, fullyChained } = combineStatements(uniqueRaw.map((p) => p.statement))

  // 4. Reconcile the combined series, with the same sign-correction + 0-tx guard
  // used for a single statement.
  const { data, corrections } = correctSignsFromBalance(combined)
  let reconciliation = checkReconciliation(data)
  if (data.transactions.length === 0) {
    reconciliation = { ...reconciliation, passed: false }
  }

  // 5. Build the per-file summary (unique files only — duplicates are reported
  // separately and excluded from the series).
  const perFile: PerFileResult[] = uniqueRaw.map((p) => {
    const dates = p.statement.transactions.map((t) => t.date).filter((d): d is string => !!d).sort()
    return {
      fileName: p.name,
      transactionCount: p.statement.transactions.length,
      openingBalance: p.statement.openingBalance,
      closingBalance: p.statement.closingBalance,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
    }
  })

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

  return { result, perFile, gaps, fullyChained, duplicates }
}

/** One current account inside a Revolut consolidated ("Custom") statement. */
export interface ConsolidatedAccountResult {
  label: string
  currency: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  reconciliation: ReconciliationResult
  transactions: Transaction[] // the account's rows (for the per-account table + CSV export)
}

/** Result of a Revolut consolidated statement: every current account, reconciled
 * SEPARATELY (each has its own currency and balance series). */
export interface ConsolidatedPipelineResult {
  bank: string
  accounts: ConsolidatedAccountResult[]
  /** True if every non-empty account reconciles. */
  allReconciled: boolean
}

/**
 * Parse a Revolut consolidated/"Custom" statement (multiple current accounts in
 * one PDF) and reconcile EACH current account on its own. Uses its own parser —
 * `revolut-parser.ts` (the per-account parser) is untouched. Savings & crypto
 * sections are out of scope for now (MVP).
 */
export async function extractConsolidated(pdfBytes: Uint8Array): Promise<ConsolidatedPipelineResult> {
  const parsed = await parseRevolutConsolidated(pdfBytes)
  const accounts: ConsolidatedAccountResult[] = parsed.accounts.map((a) => {
    const data: StatementData = {
      bank: parsed.bank,
      openingBalance: a.openingBalance,
      closingBalance: a.closingBalance,
      transactions: a.transactions,
    }
    let reconciliation = checkReconciliation(data)
    if (a.transactions.length === 0) reconciliation = { ...reconciliation, passed: false }
    return {
      label: a.label,
      currency: a.currency,
      transactionCount: a.transactions.length,
      openingBalance: a.openingBalance,
      closingBalance: a.closingBalance,
      reconciliation,
      transactions: a.transactions,
    }
  })
  const withTx = accounts.filter((a) => a.transactionCount > 0)
  // A consolidated PDF with NO current-account section at all (savings/crypto-only,
  // or an empty period) has nothing to reconcile in MVP scope — that's not a
  // failure. Only when the current-accounts section IS present do we require its
  // accounts to reconcile.
  const allReconciled = parsed.currentAccountsSection
    ? withTx.length > 0 && withTx.every((a) => a.reconciliation.passed)
    : true
  return { bank: parsed.bank, accounts, allReconciled }
}

/** Result of the smart Revolut entry: a single statement, or — for a PDF bundling
 * current accounts in several currencies — one reconciled account per currency. */
export type RevolutExtractResult =
  | { kind: "single"; result: PipelineResult }
  | { kind: "multi"; consolidated: ConsolidatedPipelineResult }

/**
 * Parse a single Revolut PDF, handling the rare MULTI-CURRENCY bundle (e.g. a EUR
 * account + a GBP account in one file) by reconciling each currency separately.
 *
 * The common single-currency statement returns `{ kind: "single" }` and behaves
 * exactly like the deterministic parser path (sign-correction + reconciliation).
 * Only when ≥2 currencies are detected do we return `{ kind: "multi" }` with one
 * `ConsolidatedAccountResult` per currency — the same shape the consolidated UI and
 * the harness already render.
 */
export async function extractRevolut(
  pdfBytes: Uint8Array,
  options: PipelineOptions = {},
): Promise<RevolutExtractResult> {
  const accounts = await parseRevolutAccounts(pdfBytes)

  // Single currency. If it has transactions, build the result directly from the
  // already-parsed data (no second parse). If it found nothing, defer to
  // extractAndReconcile so the AI-on-empty fallback still applies (the app).
  if (accounts.length <= 1) {
    const parsed = accounts[0]?.data
    if (!parsed || parsed.transactions.length === 0) {
      return { kind: "single", result: await extractAndReconcile(pdfBytes, { ...options, bank: "revolut" }) }
    }
    const { data, corrections } = correctSignsFromBalance(parsed)
    const reconciliation = checkReconciliation(data)
    return {
      kind: "single",
      result: {
        data,
        reconciliation,
        attempts: [
          {
            model: "parser:revolut",
            reconciliationPassed: reconciliation.passed,
            discrepancyCents: reconciliation.discrepancyCents,
            durationMs: 0,
          },
        ],
        modelUsed: "parser:revolut",
        fallbackUsed: false,
        corrections,
      },
    }
  }

  // Multi-currency: reconcile each currency's account on its own balance series.
  const accs: ConsolidatedAccountResult[] = accounts.map((a) => {
    const { data } = correctSignsFromBalance(a.data)
    let reconciliation = checkReconciliation(data)
    if (data.transactions.length === 0) reconciliation = { ...reconciliation, passed: false }
    return {
      label: a.currency || "account",
      currency: a.currency,
      transactionCount: data.transactions.length,
      openingBalance: data.openingBalance,
      closingBalance: data.closingBalance,
      reconciliation,
      transactions: data.transactions,
    }
  })
  const withTx = accs.filter((a) => a.transactionCount > 0)
  const allReconciled = withTx.length > 0 && withTx.every((a) => a.reconciliation.passed)
  return { kind: "multi", consolidated: { bank: "Revolut", accounts: accs, allReconciled } }
}
