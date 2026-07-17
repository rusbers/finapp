/**
 * Import a previously-EXPORTED transactions CSV back into the app — the inverse of
 * `toCsv` (`verification.ts`). Lets a user re-load already-reconciled accounts from
 * a CSV they exported earlier (no PDF re-parse, no AI), typically to reconcile them
 * against an `expenses.csv`, or to re-view / re-export after editing a value.
 *
 * Pure + client-safe (no pdfjs/Gemini): the browser reads the file text and calls
 * this directly; the rebuilt accounts feed the same `checkReconciliation`,
 * `mergeAccounts` and `matchExpenses` as a normally-extracted statement.
 *
 * Scope: only the app's OWN export format — columns (Account?, #?, Date, Description,
 * Debit, Credit, Balance, Category, Source). Third-party/bank CSVs (column mapping)
 * are a future feature.
 */

import type { StatementData, Transaction } from "./types"
import { parseCsvRows, amountToCents, normalizeDate } from "./expenses"

/** One account reconstructed from the CSV (one per distinct `Account` value; a single
 * element when the CSV has no `Account` column). Opening/closing are DERIVED from the
 * running-balance column so the result reconciles exactly like the original. */
export interface ImportedStatement {
  label: string | null // the `Account` cell value, or null when there's no Account column
  openingBalance: number
  closingBalance: number
  transactions: Transaction[]
}

/** Thrown (as an Error message) when the file isn't a recognised transactions CSV —
 * i.e. missing the Date/Debit/Credit columns (also cleanly rejects an expenses.csv). */
export const CSV_IMPORT_BAD_FORMAT = "csv-import/bad-format"
/** Thrown when the file parses but has no data rows. */
export const CSV_IMPORT_EMPTY = "csv-import/empty"

/** Split a "Source" cell ("file.pdf, page 3" | "page 3" | "file.pdf") back into its
 * `sourceFile` / `page` parts (the inverse of `transactionSource`). */
function splitSource(source: string): { sourceFile?: string; page?: number } {
  const s = source.trim()
  if (!s) return {}
  const m = /(?:^|,\s*)page\s+(\d+)\s*$/i.exec(s)
  if (m) {
    const file = s.slice(0, m.index).replace(/,\s*$/, "").trim()
    return { sourceFile: file || undefined, page: Number(m[1]) }
  }
  return { sourceFile: s }
}

/** One parsed CSV row plus the cents/order it carries (kept for balance derivation). */
interface ParsedRow {
  tx: Transaction
  account: string | null
  order: number | null // the "#" (statement-order) value, when present
  debitCents: number
  creditCents: number
  balanceCents: number | null
}

/**
 * Derive a group's opening + closing balance from its running-balance column, in
 * integer cents (robust to SPORADIC balances — AIB/BOI print the balance only at
 * block checkpoints, so many rows are blank). Opening is anchored at the FIRST printed
 * balance (walk back over the deltas before it); closing at the LAST (walk forward).
 * If no row has a balance at all: opening 0, closing = Σ(credit − debit).
 */
function deriveOpeningClosing(rows: ParsedRow[]): { openingBalance: number; closingBalance: number } {
  const firstK = rows.findIndex((r) => r.balanceCents != null)
  if (firstK === -1) {
    const sum = rows.reduce((acc, r) => acc + r.creditCents - r.debitCents, 0)
    return { openingBalance: 0, closingBalance: sum / 100 }
  }
  let deltaToK = 0
  for (let i = 0; i <= firstK; i++) deltaToK += rows[i].creditCents - rows[i].debitCents
  const openingCents = (rows[firstK].balanceCents as number) - deltaToK

  let lastM = firstK
  for (let i = rows.length - 1; i >= firstK; i--) {
    if (rows[i].balanceCents != null) {
      lastM = i
      break
    }
  }
  let deltaAfterM = 0
  for (let i = lastM + 1; i < rows.length; i++) deltaAfterM += rows[i].creditCents - rows[i].debitCents
  const closingCents = (rows[lastM].balanceCents as number) + deltaAfterM

  return { openingBalance: openingCents / 100, closingBalance: closingCents / 100 }
}

/**
 * Parse the app's exported transactions CSV into one `ImportedStatement` per account.
 * Throws `CSV_IMPORT_EMPTY` / `CSV_IMPORT_BAD_FORMAT` on an unusable file.
 */
export function parseTransactionsCsv(text: string): ImportedStatement[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""))
  if (rows.length < 2) throw new Error(CSV_IMPORT_EMPTY) // header + at least one data row

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const iDate = col("date")
  const iDesc = col("description")
  const iDebit = col("debit")
  const iCredit = col("credit")
  const iBalance = col("balance")
  const iCategory = col("category")
  const iSource = col("source")
  const iAccount = col("account")
  const iNum = col("#")
  // The reconciliation-critical trio must be present — this is what makes it OUR export
  // (and cleanly rejects an expenses.csv, which has supplier/amount but no debit/credit).
  if (iDate < 0 || iDebit < 0 || iCredit < 0) throw new Error(CSV_IMPORT_BAD_FORMAT)

  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : "")
  const hasAccountCol = iAccount >= 0
  const hasNum = iNum >= 0

  const parsed: ParsedRow[] = []
  for (const r of rows.slice(1)) {
    const debitStr = cell(r, iDebit)
    const creditStr = cell(r, iCredit)
    const balanceStr = cell(r, iBalance)
    const debitCents = debitStr ? amountToCents(debitStr) : 0
    const creditCents = creditStr ? amountToCents(creditStr) : 0
    const balanceCents = balanceStr ? amountToCents(balanceStr) : null
    const { sourceFile, page } = splitSource(cell(r, iSource))
    const account = hasAccountCol ? cell(r, iAccount) : null
    const orderStr = cell(r, iNum)
    const order = hasNum && /^\d+$/.test(orderStr) ? Number(orderStr) : null

    const tx: Transaction = {
      date: normalizeDate(cell(r, iDate)),
      description: cell(r, iDesc),
      debit: debitCents / 100,
      credit: creditCents / 100,
      balance: balanceCents == null ? null : balanceCents / 100,
    }
    const category = cell(r, iCategory)
    if (category) tx.category = category
    if (sourceFile) tx.sourceFile = sourceFile
    if (page != null) tx.page = page
    if (account) tx.accountLabel = account

    parsed.push({ tx, account, order, debitCents, creditCents, balanceCents })
  }
  if (parsed.length === 0) throw new Error(CSV_IMPORT_EMPTY)

  // Group by account (first-seen order preserved); all rows into one group if no column.
  const groups = new Map<string, ParsedRow[]>()
  const groupOrder: string[] = []
  for (const row of parsed) {
    const key = hasAccountCol ? (row.account ?? "") : ""
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key)!.push(row)
  }

  return groupOrder.map((key) => {
    const groupRows = groups.get(key)!
    // Restore statement order from "#" if present (the user may have sorted the CSV in a
    // spreadsheet; the running balance is only valid in statement order). Array.sort is
    // stable, so rows without a "#" keep their relative order.
    if (hasNum) {
      groupRows.sort((a, b) => {
        if (a.order == null && b.order == null) return 0
        if (a.order == null) return 1
        if (b.order == null) return -1
        return a.order - b.order
      })
    }
    const { openingBalance, closingBalance } = deriveOpeningClosing(groupRows)
    return {
      label: hasAccountCol ? key || null : null,
      openingBalance,
      closingBalance,
      transactions: groupRows.map((r) => r.tx),
    }
  })
}
