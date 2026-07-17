/**
 * Financial-period slicing (pure, framework-agnostic, testable).
 *
 * The accountant reconciles a closing financial YEAR. A combined upload can span
 * past the year boundary (e.g. end-2024 → start-2026); selecting a period slices
 * the extracted series into its own statement — deriving the period's OPENING
 * (the running balance entering it) and CLOSING (the running balance at its end) —
 * so the verdict is a REAL reconciliation of that period, not just hidden rows.
 *
 * Used for a single statement AND, per account, for a multi-account combined upload
 * (each account is sliced + re-reconciled independently).
 */

import type { StatementData } from "./types"

export type Period =
  | { kind: "all" }
  | { kind: "year"; year: string }
  | { kind: "range"; from: string; to: string }

export function slicePeriod(data: StatementData, period: Period): StatementData {
  if (period.kind === "all") return data
  const from = period.kind === "year" ? `${period.year}-01-01` : period.from
  const to = period.kind === "year" ? `${period.year}-12-31` : period.to
  const tx = data.transactions
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to)

  const firstIdx = tx.findIndex((t) => !!t.date && inRange(t.date))
  if (firstIdx === -1) {
    return { bank: data.bank, openingBalance: 0, closingBalance: 0, transactions: [] }
  }
  const sliceTx = tx.filter((t) => !!t.date && inRange(t.date))

  // Opening = printed running balance of the row just before the period's first row
  // (in series order); if the period starts at/before the data, the statement's own
  // opening. Fallback (no balances): opening + Σ(credit−debit) of the rows before it.
  const prev = firstIdx > 0 ? tx[firstIdx - 1] : null
  const openingBalance =
    firstIdx === 0
      ? data.openingBalance
      : prev && prev.balance != null
        ? prev.balance
        : data.openingBalance +
          tx.slice(0, firstIdx).reduce((sum, t) => sum + (t.credit || 0) - (t.debit || 0), 0)

  // Closing = printed running balance of the period's last row (fallback: computed).
  const last = sliceTx[sliceTx.length - 1]
  const closingBalance =
    last.balance != null
      ? last.balance
      : openingBalance + sliceTx.reduce((sum, t) => sum + (t.credit || 0) - (t.debit || 0), 0)

  return { bank: data.bank, openingBalance, closingBalance, transactions: sliceTx }
}
