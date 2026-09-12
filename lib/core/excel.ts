/**
 * Excel (.xlsx) export — the PURE half: turns the app's data into typed sheet rows.
 *
 * Why a second export next to CSV: Excel mangles our CSV for EU users — without a BOM,
 * Romanian/Cyrillic descriptions become mojibake, and on a Windows whose list separator is
 * ";" (RO/DE/FR locales) every row lands in ONE column. An .xlsx opens identically
 * everywhere, and dates/amounts are real values (sortable, summable), not text. It can also
 * hold several sheets, so a multi-account client gets ONE file. CSV stays for imports into
 * other software.
 *
 * This module knows nothing about the xlsx library: it produces `XlsxSheet` objects whose
 * cells use a small shape (`{ value, type, format, fontWeight }`) that `write-excel-file`
 * accepts as-is. The browser wiring (`app/excel-export.ts`) hands them to the library; the
 * Node test (`scripts/test-excel.mts`) asserts on them directly.
 *
 * Column rules mirror `toCsv` (verification.ts) so the two exports never disagree.
 */

import type { StatementData } from "./types"
import { transactionSource } from "./verification"
import { expensesReportRows, type ExpenseReport } from "./expenses"

/** A cell: a bare value, an empty cell, or a typed/formatted value. */
export type XlsxCell =
  | string
  | number
  | null
  | {
      value: string | number | Date
      type?: StringConstructor | NumberConstructor | DateConstructor
      format?: string
      fontWeight?: "bold"
    }

export interface XlsxSheet {
  name: string
  rows: XlsxCell[][]
  columns?: { width: number }[] // widths in characters, one per column
  stickyRowsCount?: number // frozen header rows
}

/** Excel cell number formats. Dates use the Irish/EU day-first order. */
export const DATE_FORMAT = "dd/mm/yyyy"
export const MONEY_FORMAT = "#,##0.00"

// --- Cell helpers -------------------------------------------------------------------

function bold(label: string): XlsxCell {
  return { value: label, fontWeight: "bold" }
}

/** A money cell, or an empty cell when the amount is absent — the CSV leaves it blank too. */
function money(amount: number | null | undefined): XlsxCell {
  return amount == null ? null : { value: amount, type: Number, format: MONEY_FORMAT }
}

/** A DATE cell from the app's ISO "YYYY-MM-DD" string. Built at UTC midnight so the
 * calendar day survives the local-timezone conversion the library applies. Anything that
 * is not a clean ISO date (an odd AI-path value, or empty) is written as text, unchanged. */
function dateCell(iso: string): XlsxCell {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "")
  if (!m) return iso || null
  return { value: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), type: Date, format: DATE_FORMAT }
}

// --- Sheet names ---------------------------------------------------------------------

const SHEET_NAME_MAX = 31 // Excel's hard limit
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g

/**
 * A valid, unique Excel sheet name for `label`: forbidden characters stripped, capped at
 * 31 characters, never empty, and numbered (" (2)", " (3)"…) if already in `used` — which
 * is also updated, so callers pass one Set across a whole workbook.
 */
export function sheetName(label: string, used: Set<string>): string {
  const base = (label.replace(SHEET_NAME_FORBIDDEN, "").trim() || "Sheet").slice(0, SHEET_NAME_MAX)
  let name = base
  for (let n = 2; used.has(name); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix
  }
  used.add(name)
  return name
}

// --- Sheets --------------------------------------------------------------------------

/**
 * A statement's transactions, same columns and rules as `toCsv(..., { rowNumbers: true })`:
 * Account (only when any row carries `accountLabel`), # (1-based statement order), Date,
 * Description, Debit, Credit, Balance, Category, Source — but typed: real dates, real
 * numbers (blank where the CSV is blank), bold frozen header.
 */
export function transactionSheet(
  name: string,
  data: StatementData,
  opts: { defaultSource?: string } = {},
): XlsxSheet {
  const txs = data.transactions ?? []
  const hasAccount = txs.some((t) => t.accountLabel)
  const header: XlsxCell[] = [
    ...(hasAccount ? [bold("Account")] : []),
    bold("#"),
    bold("Date"),
    bold("Description"),
    bold("Debit"),
    bold("Credit"),
    bold("Balance"),
    bold("Category"),
    bold("Source"),
  ]
  const rows = txs.map((t, i): XlsxCell[] => [
    ...(hasAccount ? [t.accountLabel ?? ""] : []),
    i + 1,
    dateCell(t.date),
    t.description ?? "",
    money(t.debit || null),
    money(t.credit || null),
    money(t.balance),
    t.category ?? "",
    transactionSource(t, opts.defaultSource),
  ])
  const columns = [
    ...(hasAccount ? [{ width: 14 }] : []),
    { width: 6 }, // #
    { width: 12 }, // Date
    { width: 50 }, // Description
    { width: 12 }, // Debit
    { width: 12 }, // Credit
    { width: 14 }, // Balance
    { width: 16 }, // Category
    { width: 30 }, // Source
  ]
  return { name, rows: [header, ...rows], columns, stickyRowsCount: 1 }
}

/** One line of the Summary sheet — what the on-screen per-account header shows. */
export interface SummaryAccount {
  label: string
  bank?: string
  currency?: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  passed: boolean
}

/** The first sheet of a multi-account / consolidated workbook: one line per account. */
export function summarySheet(accounts: SummaryAccount[], name = "Summary"): XlsxSheet {
  const header = ["Account", "Bank", "Currency", "Transactions", "Opening", "Closing", "Reconciled"].map(bold)
  const rows = accounts.map((a): XlsxCell[] => [
    a.label,
    a.bank ?? "",
    a.currency ?? "",
    a.transactionCount,
    money(a.openingBalance),
    money(a.closingBalance),
    a.transactionCount === 0 ? "—" : a.passed ? "✓" : "✗",
  ])
  const columns = [{ width: 24 }, { width: 18 }, { width: 10 }, { width: 13 }, { width: 14 }, { width: 14 }, { width: 12 }]
  return { name, rows: [header, ...rows], columns, stickyRowsCount: 1 }
}

/**
 * The expense-reconciliation report: the original expenses.csv columns verbatim (as text,
 * exactly like the CSV export) plus the appended match columns. Built from the SAME rows
 * as `expensesReportToCsv`; the only typing applied is "Days" → number, so the signed gap
 * sorts and filters numerically.
 */
export function expensesSheet(report: ExpenseReport, name = "Expenses"): XlsxSheet {
  const { header, rows } = expensesReportRows(report)
  const daysCol = header.length - 2 // …, Days, Source
  const typed = rows.map((r): XlsxCell[] =>
    r.map((cell, i) => (i === daysCol && cell !== "" ? Number(cell) : cell)),
  )
  const columns = header.map((h, i) => ({
    width: i < header.length - 6 ? 18 : h === "Matched description" || h === "Source" ? 30 : 12,
  }))
  return { name, rows: [header.map(bold), ...typed], columns, stickyRowsCount: 1 }
}
