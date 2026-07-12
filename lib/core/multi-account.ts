/**
 * Multi-account reconciliation — PURE, client-safe half.
 *
 * A single client can hold several bank accounts (e.g. AIB + BOI + Revolut).
 * Each account is reconciled INDEPENDENTLY (its own bank parser, its own balance
 * series); this module only carries the shared types and the two pure helpers the
 * browser needs:
 *   - `dedupeLabels`  — turn the per-account labels into distinct display names.
 *   - `mergeAccounts` — interleave every account's rows into ONE chronological list
 *                       for the combined table, stamping each row with its account.
 *
 * It imports ONLY `type`s (all erased at build), so `app/page.tsx` can import it
 * without pulling the server-only pipeline (pdfjs worker + Gemini) into the client
 * bundle. The server orchestration lives in `multi-account-extract.ts`.
 *
 * NOTE: this is a REDUCED scope on purpose — there is NO cross-account transfer
 * detection here. Accounts are merely reconciled and shown side by side.
 */

import type { Transaction, ReconciliationResult } from "./types"
import type { BankId } from "./prompts"
import type { PerFileResult, DuplicateStatement } from "./pipeline"
import type { StatementGap } from "./combine"

/** One reconciled account in the combined view. Mirrors a consolidated account,
 * plus the multi-file metadata (a single account may itself be several PDFs). */
export interface MultiAccount {
  label: string
  bank: BankId
  currency?: string // set when a Revolut bundle is split by currency
  transactionCount: number
  openingBalance: number
  closingBalance: number
  reconciliation: ReconciliationResult
  transactions: Transaction[]
  fileNames: string[]
  // Present only when this account was several PDFs chained together:
  perFile?: PerFileResult[]
  gaps?: StatementGap[]
  fullyChained?: boolean
  duplicates?: DuplicateStatement[]
}

export interface MultiAccountResult {
  accounts: MultiAccount[]
  /** True when every account WITH transactions reconciles (0-tx accounts don't count). */
  allReconciled: boolean
}

/**
 * Turn the raw per-account labels into DISTINCT display names. The caller has
 * already substituted the bank's short label for any empty entry, so here we only
 * disambiguate duplicates: the first "BOI" stays "BOI", the next becomes "BOI (2)",
 * then "BOI (3)"… A name is bumped until it is free, so it never collides with a
 * user-typed "BOI (2)" either.
 */
export function dedupeLabels(labels: string[]): string[] {
  const used = new Set<string>()
  return labels.map((raw) => {
    const base = raw.trim()
    let name = base
    let n = 1
    while (used.has(name)) {
      n += 1
      name = `${base} (${n})`
    }
    used.add(name)
    return name
  })
}

/**
 * Interleave every account's rows into ONE chronological list for the combined
 * table. Each row is COPIED with `accountLabel` set (display-only) so the table can
 * show which account it came from and filter/sort by it.
 *
 * Sort is stable: by ISO date ascending (rows without a date sort first), ties broken
 * by account order then the row's original position — so within a day an account's
 * internal order (and thus its running balance) is preserved.
 */
export function mergeAccounts(
  accounts: { label: string; transactions: Transaction[] }[],
): { transactions: Transaction[] } {
  const rows = accounts.flatMap((acc, accountIdx) =>
    acc.transactions.map((t, txIdx) => ({ t, label: acc.label, accountIdx, txIdx })),
  )
  rows.sort((a, b) => {
    const byDate = (a.t.date ?? "").localeCompare(b.t.date ?? "")
    if (byDate !== 0) return byDate
    if (a.accountIdx !== b.accountIdx) return a.accountIdx - b.accountIdx
    return a.txIdx - b.txIdx
  })
  return { transactions: rows.map(({ t, label }) => ({ ...t, accountLabel: label })) }
}
