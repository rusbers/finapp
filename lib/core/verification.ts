/**
 * Helpers for the test/verification workflow:
 *   - CSV export (to compare against other tools like DocuClipper)
 *   - row-by-row running-balance check (locates exactly where things break)
 *
 * Pure functions, no dependencies beyond shared types. Reusable everywhere.
 */

import type { StatementData, Transaction } from "./types"
import { toCents, fromCents } from "./reconciliation"

/** Escape a value for safe inclusion in a CSV cell. */
function csvCell(value: string | number): string {
  const s = String(value ?? "")
  // Quote if it contains comma, quote, or newline; double any inner quotes.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Build a CSV string from the extracted statement.
 * Columns: Date, Description, Debit, Credit, Balance — in statement order.
 */
export function toCsv(data: StatementData): string {
  const header = ["Date", "Description", "Debit", "Credit", "Balance"]
  const rows = (data.transactions ?? []).map((t) => [
    csvCell(t.date),
    csvCell(t.description),
    csvCell(t.debit ? t.debit.toFixed(2) : ""),
    csvCell(t.credit ? t.credit.toFixed(2) : ""),
    csvCell(t.balance != null ? t.balance.toFixed(2) : ""),
  ])
  return [header, ...rows].map((r) => r.join(",")).join("\n")
}

/** Trigger a CSV download in the browser. */
export function downloadCsv(data: StatementData, fileName: string): void {
  const csv = toCsv(data)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export interface BalanceBreak {
  index: number // 0-based position in the transactions array
  transaction: Transaction
  expectedCents: number // previous balance + credit - debit
  actualCents: number // the balance the statement shows on this row
  deltaCents: number // actual - expected
}

/**
 * Row-by-row check using the running balance:
 *   previousBalance + credit - debit  should equal  thisRow.balance
 * Returns the rows where it does NOT match — i.e. exactly where extraction broke.
 *
 * Only works if the statement provides a running balance on each row. If balances
 * are missing (null), returns an empty list (nothing to check against).
 */
export function findBalanceBreaks(data: StatementData, toleranceCents = 2): BalanceBreak[] {
  const txs = data.transactions ?? []
  const breaks: BalanceBreak[] = []

  // Start from the opening balance; walk down row by row.
  let prevCents = toCents(data.openingBalance ?? 0)

  for (let i = 0; i < txs.length; i++) {
    const t = txs[i]
    if (t.balance == null) {
      // No balance on this row — we can't verify it; carry expectation forward.
      prevCents = prevCents + toCents(t.credit ?? 0) - toCents(t.debit ?? 0)
      continue
    }
    const expectedCents = prevCents + toCents(t.credit ?? 0) - toCents(t.debit ?? 0)
    const actualCents = toCents(t.balance)
    const deltaCents = actualCents - expectedCents

    if (Math.abs(deltaCents) > toleranceCents) {
      breaks.push({ index: i, transaction: t, expectedCents, actualCents, deltaCents })
    }
    // Continue from the statement's actual balance (so one break doesn't
    // cascade into flagging every following row).
    prevCents = actualCents
  }

  return breaks
}

/** Convenience: a short human-readable summary line for a balance break. */
export function describeBreak(b: BalanceBreak): string {
  return (
    `Row ${b.index + 1} (${b.transaction.date} ${b.transaction.description}): ` +
    `expected ${fromCents(b.expectedCents)}, statement shows ${fromCents(b.actualCents)} ` +
    `(off by ${fromCents(Math.abs(b.deltaCents))})`
  )
}
