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
}

export interface StatementData {
  bank: string
  openingBalance: number
  closingBalance: number
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

/** Full result of the extract-and-reconcile pipeline. */
export interface PipelineResult {
  data: StatementData
  reconciliation: ReconciliationResult
  attempts: ExtractionAttempt[] // every model tried, in order
  modelUsed: string // the model whose result we're returning
  fallbackUsed: boolean // did we go beyond the primary model?
}
