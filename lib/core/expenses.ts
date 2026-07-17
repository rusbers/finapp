/**
 * Expense reconciliation — match a list of known expenses (from an accounting
 * export `expenses.csv`) against the bank statement's debit transactions.
 *
 * For each expense we look for a debit whose amount matches to the cent within a
 * small date window (card postings can lag the receipt date by a few days). A
 * matched transaction is tagged `category = "Expense"`; the returned report lists
 * every expense with a found / not-found flag (and where it matched), so an
 * accountant can see which expenses are missing from the bank.
 *
 * Pure + client-safe (no pdfjs/Gemini): the route parses/matches server-side; the
 * UI reuses the types + `expensesReportToCsv` for the download.
 */

import type { Transaction } from "./types"
import { toCents } from "./reconciliation"
import { csvCell } from "./verification"

/** A day window (either side) within which a debit may match an expense's date. */
export const DEFAULT_WINDOW_DAYS = 7

export interface Expense {
  supplier: string
  description: string
  category: string
  date: string // ISO YYYY-MM-DD
  amount: number // display value (major units)
  amountCents: number
  link?: string // optional URL to the expense (some exports carry a "link"/"url" column)
  raw?: string[] // this row's original cells, verbatim — so the export can reproduce the source CSV
  rawHeader?: string[] // the original header row, verbatim (shared across expenses) — for the export
}

export interface ExpenseMatch {
  expense: Expense
  found: boolean
  matchedDate?: string
  matchedAccount?: string
  matchedDescription?: string
  matchedSourceFile?: string // the PDF the matched debit came from (when several were combined)
  matchedPage?: number // 1-based page of that PDF (deterministic parsers)
}

export interface ExpenseReport {
  matches: ExpenseMatch[]
  total: number
  foundCount: number
}

/** One statement debit candidate, carrying its account label for the report. */
export interface MatchEntry {
  tx: Transaction
  account?: string
}

// --- CSV parsing ----------------------------------------------------------

/**
 * Split CSV text into rows of fields, honouring quoted fields (embedded commas /
 * newlines) and `""` escapes — the mirror of `csvCell`'s quoting.
 *
 * Exported (with the two cell helpers below) so the transactions-CSV importer
 * (`csv-import.ts`) can reuse the exact same reader — one CSV engine, not two.
 */
export function parseCsvRows(text: string): string[][] {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++ // skip the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += c
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Normalise a date cell to ISO YYYY-MM-DD (accepts ISO or DD/MM/YYYY). */
export function normalizeDate(s: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`
  return s.trim()
}

/** Parse an amount cell into integer cents. Strips currency symbols + thousands
 * separators (dot-decimal / comma-thousands, as in the Irish/UK exports). */
export function amountToCents(s: string): number {
  const cleaned = s.replace(/[^0-9.\-]/g, "") // drop currency, commas, spaces
  if (!cleaned || cleaned === "-" || cleaned === ".") return 0
  return toCents(cleaned)
}

/**
 * Parse an `expenses.csv` (Supplier, Description, Category, Date, Amount, VAT…).
 * Columns are matched by header name (case-insensitive); extra columns are ignored.
 */
export function parseExpensesCsv(text: string): Expense[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""))
  if (rows.length < 2) return []
  const rawHeader = rows[0].map((h) => h.trim()) // original column names (for the export)
  const header = rawHeader.map((h) => h.toLowerCase()) // lower-cased, for matching only
  const col = (name: string) => header.findIndex((h) => h === name)
  const iSupplier = col("supplier")
  const iDescription = col("description")
  const iCategory = col("category")
  const iDate = col("date")
  const iAmount = col("amount")
  // The link column's exact name isn't fixed across exports — match on substring
  // (e.g. "Link", "URL", "Expense link", "Receipt URL"). First matching column wins.
  const iLink = header.findIndex((h) => h.includes("link") || h.includes("url"))
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : "")

  const expenses: Expense[] = []
  for (const r of rows.slice(1)) {
    const supplier = get(r, iSupplier)
    const description = get(r, iDescription)
    const amountStr = get(r, iAmount)
    if (!supplier && !description && !amountStr) continue // fully blank row
    const amountCents = amountToCents(amountStr)
    expenses.push({
      supplier,
      description,
      category: get(r, iCategory),
      date: normalizeDate(get(r, iDate)),
      amount: amountCents / 100,
      amountCents,
      link: get(r, iLink) || undefined,
      raw: r,
      rawHeader,
    })
  }
  return expenses
}

// --- Matching -------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000
}

function withinWindow(a: string, b: string, windowDays: number): boolean {
  const da = Date.parse(a)
  const db = Date.parse(b)
  if (Number.isNaN(da) || Number.isNaN(db)) return false
  return Math.abs(db - da) <= windowDays * 86_400_000
}

/** Supplier words (>=4 chars) used as a tie-breaker against the bank description. */
function supplierTokens(supplier: string): string[] {
  return (supplier || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
}

/** Of several same-amount, in-window candidates, prefer one whose description
 * contains the supplier, then the closest date, then a deterministic order. */
function pickBest(expense: Expense, candidates: MatchEntry[]): MatchEntry {
  const tokens = supplierTokens(expense.supplier)
  const supplierMiss = (e: MatchEntry) => {
    const desc = (e.tx.description || "").toLowerCase()
    return tokens.some((w) => desc.includes(w)) ? 0 : 1
  }
  return [...candidates].sort((x, y) => {
    const sm = supplierMiss(x) - supplierMiss(y)
    if (sm !== 0) return sm
    const dd = daysBetween(expense.date, x.tx.date) - daysBetween(expense.date, y.tx.date)
    if (dd !== 0) return dd
    return (
      (x.tx.date ?? "").localeCompare(y.tx.date ?? "") ||
      (x.tx.description ?? "").localeCompare(y.tx.description ?? "")
    )
  })[0]
}

/**
 * Match each expense to a statement debit (exact cents + date window, one-to-one).
 * MUTATES matched transactions' `category` to "Expense". Returns the report.
 */
export function matchExpenses(
  expenses: Expense[],
  entries: MatchEntry[],
  opts: { windowDays?: number } = {},
): ExpenseReport {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS

  // Index debit entries by their cent amount (a debit is used at most once).
  const byCents = new Map<number, MatchEntry[]>()
  for (const e of entries) {
    const cents = toCents(e.tx.debit ?? 0)
    if (cents <= 0) continue
    const arr = byCents.get(cents)
    if (arr) arr.push(e)
    else byCents.set(cents, [e])
  }

  const used = new Set<MatchEntry>()
  const matches: ExpenseMatch[] = []
  let foundCount = 0

  for (const expense of expenses) {
    let match: ExpenseMatch = { expense, found: false }
    if (expense.amountCents > 0) {
      const candidates = (byCents.get(expense.amountCents) ?? []).filter(
        (e) => !used.has(e) && withinWindow(expense.date, e.tx.date, windowDays),
      )
      if (candidates.length > 0) {
        const best = pickBest(expense, candidates)
        used.add(best)
        best.tx.category = "Expense"
        best.tx.categoryByAi = false
        match = {
          expense,
          found: true,
          matchedDate: best.tx.date,
          matchedAccount: best.account,
          matchedDescription: best.tx.description,
          matchedSourceFile: best.tx.sourceFile,
          matchedPage: best.tx.page,
        }
        foundCount += 1
      }
    }
    matches.push(match)
  }

  return { matches, total: expenses.length, foundCount }
}

// --- Export ---------------------------------------------------------------

/**
 * Export the ORIGINAL expenses.csv verbatim (every column, incl. VAT and the link column
 * under its own original name) with four columns appended: Found, Matched account, Matched
 * date, Source (file + page of the matched debit). The source rows/columns are never mutated
 * — only these are added at the end. (The single "Matched" cell is a UI-only presentation; the
 * export keeps account and date as separate columns for spreadsheet use.)
 */
export function expensesReportToCsv(report: ExpenseReport): string {
  const originalHeader = report.matches[0]?.expense.rawHeader ?? []
  const header = [...originalHeader, "Found", "Matched account", "Matched date", "Source"]
  const rows = report.matches.map((m) => {
    const source =
      m.found && m.matchedSourceFile
        ? `${m.matchedSourceFile}${m.matchedPage != null ? `, page ${m.matchedPage}` : ""}`
        : ""
    // Pad a short row up to the header width so the appended columns stay aligned.
    const original = m.expense.raw ?? []
    const padded =
      original.length < originalHeader.length
        ? [...original, ...Array(originalHeader.length - original.length).fill("")]
        : original
    return [
      ...padded,
      m.found ? "found" : "not found",
      m.matchedAccount ?? "",
      m.matchedDate ?? "",
      source,
    ]
  })
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")
}
