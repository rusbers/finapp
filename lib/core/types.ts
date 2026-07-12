/**
 * Shared domain types — the single source of truth for the data shapes.
 * Both extraction and reconciliation import from here, so neither depends on
 * the other just for a type. Reused by web, future API, and future mobile.
 */

export interface Transaction {
  date: string // YYYY-MM-DD
  description: string
  debit: number // money out, positive number (0 if not applicable)
  credit: number // money in, positive number (0 if not applicable)
  balance: number | null // running balance after this transaction (null if the statement doesn't show one)
  page?: number // 1-based page of the source PDF this row came from (deterministic parsers only)
  sourceFile?: string // file this row came from (set only when several PDFs are combined)
  category?: string // assigned by the categorization step (rules + AI); never affects reconciliation
  categoryByAi?: boolean // true when the AI layer (not a keyword rule) assigned the category
  accountLabel?: string // which account this row belongs to (set only in the multi-account combined view); display-only, never fingerprinted
}

export interface StatementData {
  bank: string
  openingBalance: number
  closingBalance: number
  transactions: Transaction[]
  // The statement's DECLARED opening date (the first BALANCE FORWARD / OPENING BALANCE
  // row) — the true start of the covered period, which can PRECEDE the first
  // transaction (a statement may open then stay dormant for weeks). Set by the AIB/BOI
  // parsers; used only for gap detection when combining several PDFs. Display-only,
  // never part of reconciliation or the regression fingerprint.
  openingDate?: string
}

/**
 * Result of extracting a single PDF chunk (a few pages of a larger statement).
 * Opening/closing balances may be null when those pages don't show them
 * (only the first/last page of the full statement carry them).
 */
export interface ExtractedChunk {
  bank: string
  openingBalance: number | null
  closingBalance: number | null
  transactions: Transaction[]
}

export interface ReconciliationResult {
  passed: boolean
  discrepancyCents: number // how far the computed balance is from the declared one
  totalCreditCents: number
  totalDebitCents: number
  openingBalanceCents: number
  closingBalanceCents: number
  computedBalanceCents: number
}

/** One model attempt in the extraction pipeline (for stats/diagnostics). */
export interface ExtractionAttempt {
  model: string
  reconciliationPassed: boolean
  discrepancyCents: number
  durationMs: number
}

/** A single debit/credit correction made by checking the running balance. */
export interface SignCorrection {
  index: number // position in the transactions array
  date: string
  description: string
  amount: number // the (unchanged) magnitude
  from: "debit" | "credit" // what the model originally had
  to: "debit" | "credit" // what the balance shows it should be
}

/** Full result of the extract-and-reconcile pipeline. */
export interface PipelineResult {
  data: StatementData
  reconciliation: ReconciliationResult
  attempts: ExtractionAttempt[] // every model tried, in order
  modelUsed: string // the model whose result we're returning
  fallbackUsed: boolean // did we go beyond the primary model?
  corrections: SignCorrection[] // debit/credit fixes applied from the balance
}
