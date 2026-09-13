/**
 * The shape of what POST /api/extract returns, as the client sees it. Moved out of
 * `page.tsx` so that other browser modules (the recent-reconciliations store) can
 * type the result without importing a page file. Type-only — nothing runs here.
 */

import type {
  StatementData,
  ReconciliationResult,
  ExtractionAttempt,
  SignCorrection,
  Transaction,
} from "@/lib/core/types"
import type { MultiAccountResult } from "@/lib/core/multi-account"
import type { ExpenseReport } from "@/lib/core/expenses"

export interface PerFileResult {
  fileName: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  periodStart: string | null
  periodEnd: string | null
}

export interface StatementGap {
  afterClosingBalance: number
  nextOpeningBalance: number | null
  beforeEnd: string | null
  afterStart: string | null
}

export interface DuplicateStatement {
  fileName: string
  duplicateOf: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  periodStart: string | null
  periodEnd: string | null
}

export interface ConsolidatedAccount {
  label: string
  currency: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  reconciliation: ReconciliationResult
  transactions: Transaction[]
}
export interface ConsolidatedResponse {
  bank: string
  allReconciled: boolean
  accounts: ConsolidatedAccount[]
}

export interface ApiResponse {
  // `data` is ABSENT for a multi-account result (see `multi` below), so it's optional.
  // The other single-statement fields below are only ever read inside the single-mode
  // render branch (gated on a non-null reconciliation), so they stay required — the
  // multi response simply omits them and is never asked for them.
  data?: StatementData
  reconciliation: ReconciliationResult
  attempts: ExtractionAttempt[]
  modelUsed: string
  fallbackUsed: boolean
  corrections: SignCorrection[]
  fileName: string
  // Present only when multiple statements were combined:
  perFile?: PerFileResult[]
  gaps?: StatementGap[]
  fullyChained?: boolean
  duplicates?: DuplicateStatement[]
  // Present only when categorization ran (toggle on):
  categorization?: { ruleCount: number; aiCount: number; uniqueAiDescriptions: number } | null
  // Present only for a Revolut consolidated statement (per-account results):
  consolidated?: ConsolidatedResponse
  // Present only for a multi-account client (several bank accounts, combined table):
  multi?: MultiAccountResult
  // Present only when an expenses.csv was uploaded (matched against the statement debits):
  expenses?: ExpenseReport
  // Client-only: set when the result was rebuilt from a re-imported CSV/Excel export
  // (`handleImportFile`), never by the route. `fileName` is then the import file, which
  // must NOT stand in as a row's source — the rows carry their original PDF (or nothing).
  imported?: true
}
