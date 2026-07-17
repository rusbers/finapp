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
export function csvCell(value: string | number): string {
  const s = String(value ?? "")
  // Quote if it contains comma, quote, or newline; double any inner quotes.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Where a transaction came from, as a single label: "file.pdf, page 3" /
 * "page 3" / "file.pdf" / "". The file falls back to `fallbackFile` (the uploaded
 * name) for a single-file run, where rows don't carry their own `sourceFile`.
 */
export function transactionSource(t: Transaction, fallbackFile?: string): string {
  const file = t.sourceFile ?? fallbackFile ?? ""
  const page = t.page != null ? `page ${t.page}` : ""
  return [file, page].filter(Boolean).join(", ")
}

/**
 * Build a CSV string from the extracted statement.
 * Columns: Date, Description, Debit, Credit, Balance, Category, Source — in statement order.
 *
 * When any row carries an `accountLabel`, an "Account" column is prepended — the route
 * stamps the bank on single-account statements and the account labels on multi-account
 * ones. The deterministic core never sets `accountLabel`, so statements exported straight
 * from it (the regression harness) get NO column and stay byte-for-byte identical.
 */
export function toCsv(data: StatementData, opts: { defaultSource?: string } = {}): string {
  const txs = data.transactions ?? []
  const hasAccount = txs.some((t) => t.accountLabel)
  const header = [
    ...(hasAccount ? ["Account"] : []),
    "Date",
    "Description",
    "Debit",
    "Credit",
    "Balance",
    "Category",
    "Source",
  ]
  const rows = txs.map((t) => [
    ...(hasAccount ? [csvCell(t.accountLabel ?? "")] : []),
    csvCell(t.date),
    csvCell(t.description),
    csvCell(t.debit ? t.debit.toFixed(2) : ""),
    csvCell(t.credit ? t.credit.toFixed(2) : ""),
    csvCell(t.balance != null ? t.balance.toFixed(2) : ""),
    csvCell(t.category ?? ""),
    csvCell(transactionSource(t, opts.defaultSource)),
  ])
  return [header, ...rows].map((r) => r.join(",")).join("\n")
}

/** Trigger a CSV download in the browser. */
export function downloadCsv(data: StatementData, fileName: string, defaultSource?: string): void {
  const csv = toCsv(data, { defaultSource })
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

/**
 * Revolut prints crypto-sell proceeds GROSS as "money in" but credits the NET
 * (after an unitemized spread/fee) to the running balance, e.g. "Transfer from
 * Revolut Digital Assets Europe Ltd / Sell of X". The fee isn't printed anywhere,
 * so such rows make the statement go out of balance through NO extraction error —
 * we read the printed amounts faithfully. Detect the case where EVERY balance
 * break is one of these rows, so the UI can show a softer, explained note instead
 * of a hard failure (distinguishing it from a genuinely broken reconciliation).
 */
const CRYPTO_SELL_RE = /transfer from revolut digital assets/i

export function isExplainedByCryptoFees(breaks: BalanceBreak[]): boolean {
  if (breaks.length === 0) return false
  return breaks.every(
    (b) => b.deltaCents < 0 && CRYPTO_SELL_RE.test(b.transaction.description),
  )
}

/** Convenience: a short human-readable summary line for a balance break. */
export function describeBreak(b: BalanceBreak): string {
  return (
    `Row ${b.index + 1} (${b.transaction.date} ${b.transaction.description}): ` +
    `expected ${fromCents(b.expectedCents)}, statement shows ${fromCents(b.actualCents)} ` +
    `(off by ${fromCents(Math.abs(b.deltaCents))})`
  )
}
