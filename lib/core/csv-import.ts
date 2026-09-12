/**
 * Import a previously-EXPORTED transactions file back into the app — the inverse of
 * `toCsv` (`verification.ts`) and of `transactionSheet` (`excel.ts`). Lets a user re-load
 * already-reconciled accounts from a CSV or an Excel workbook they exported earlier (no PDF
 * re-parse, no AI), typically to reconcile them against an `expenses.csv` after typing
 * categories in a spreadsheet, or to re-view / re-export after editing a value.
 *
 * Pure + client-safe (no pdfjs/Gemini/xlsx library): the browser reads the file — text for
 * a CSV, typed sheet rows for an .xlsx (see `app/import-file.ts`) — and calls this
 * directly; the rebuilt accounts feed the same `checkReconciliation`, `mergeAccounts` and
 * `matchExpenses` as a normally-extracted statement.
 *
 * Scope: only the app's OWN export format — columns (Account?, #?, Date, Description,
 * Debit, Credit, Balance, Category, Source). Third-party/bank CSVs (column mapping)
 * are a future feature.
 */

import type { StatementData, Transaction } from "./types"
import type { PerFileResult } from "./pipeline"
import { parseCsvRows, amountToCents, normalizeDate } from "./expenses"
import { toCents } from "./reconciliation"

/** One account reconstructed from the file (one per distinct `Account` value; a single
 * element when there is no Account column). Opening/closing are DERIVED from the
 * running-balance column so the result reconciles exactly like the original. */
export interface ImportedStatement {
  label: string | null // the `Account` cell value (or the sheet name), or null when neither applies
  openingBalance: number
  closingBalance: number
  transactions: Transaction[]
}

/** Thrown (as an Error message) when the file isn't a recognised transactions export —
 * i.e. missing the Date/Debit/Credit columns (also cleanly rejects an expenses.csv), or an
 * Excel workbook with no such sheet. */
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

/** One parsed row plus the cents/order it carries (kept for balance derivation). */
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
function deriveOpeningClosing(
  rows: { debitCents: number; creditCents: number; balanceCents: number | null }[],
): { openingBalance: number; closingBalance: number } {
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

/** Column indexes of one header row (−1 = absent), lower-cased/trimmed matching. */
interface Columns {
  date: number
  desc: number
  debit: number
  credit: number
  balance: number
  category: number
  source: number
  account: number
  num: number
}

function columnsOf(header: string[]): Columns {
  const h = header.map((c) => c.trim().toLowerCase())
  const col = (name: string) => h.indexOf(name)
  return {
    date: col("date"),
    desc: col("description"),
    debit: col("debit"),
    credit: col("credit"),
    balance: col("balance"),
    category: col("category"),
    source: col("source"),
    account: col("account"),
    num: col("#"),
  }
}

/** The reconciliation-critical trio — this is what makes a header OUR export (and cleanly
 * rejects an expenses.csv, the workbook's Summary/Expenses sheets, …). */
function isTransactionsHeader(c: Columns): boolean {
  return c.date >= 0 && c.debit >= 0 && c.credit >= 0
}

/**
 * Parse already-split rows (header first) of the app's transactions export into one
 * `ImportedStatement` per account. Shared by the CSV and the Excel readers.
 * `defaultLabel` names the single account when the rows carry no Account column (the
 * Excel reader passes the sheet name; a CSV has no such name → null).
 * Throws `CSV_IMPORT_EMPTY` / `CSV_IMPORT_BAD_FORMAT` on an unusable file.
 */
export function parseTransactionRows(
  rows: string[][],
  opts: { defaultLabel?: string | null; decimalComma?: boolean } = {},
): ImportedStatement[] {
  const nonBlank = rows.filter((r) => r.some((c) => c.trim() !== ""))
  if (nonBlank.length < 2) throw new Error(CSV_IMPORT_EMPTY) // header + at least one data row

  const cols = columnsOf(nonBlank[0])
  if (!isTransactionsHeader(cols)) throw new Error(CSV_IMPORT_BAD_FORMAT)

  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : "")
  // Money cells: our exports are dot-decimal; a ";"-locale spreadsheet writes "1.234,56"
  // (or "19,5"), which `amountToCents` would read as 123456 — so those are turned into
  // the dot form first (thousands dots dropped, the comma becomes the decimal point).
  const money = (s: string) =>
    amountToCents(opts.decimalComma ? s.replace(/\./g, "").replace(",", ".") : s)
  const hasAccountCol = cols.account >= 0
  const hasNum = cols.num >= 0

  const parsed: ParsedRow[] = []
  for (const r of nonBlank.slice(1)) {
    const debitStr = cell(r, cols.debit)
    const creditStr = cell(r, cols.credit)
    const balanceStr = cell(r, cols.balance)
    const debitCents = debitStr ? money(debitStr) : 0
    const creditCents = creditStr ? money(creditStr) : 0
    const balanceCents = balanceStr ? money(balanceStr) : null
    const { sourceFile, page } = splitSource(cell(r, cols.source))
    const account = hasAccountCol ? cell(r, cols.account) : null
    const orderStr = cell(r, cols.num)
    const order = hasNum && /^\d+$/.test(orderStr) ? Number(orderStr) : null

    const tx: Transaction = {
      date: normalizeDate(cell(r, cols.date)),
      description: cell(r, cols.desc),
      debit: debitCents / 100,
      credit: creditCents / 100,
      balance: balanceCents == null ? null : balanceCents / 100,
    }
    const category = cell(r, cols.category)
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
    // Restore statement order from "#" if present (the user may have sorted the file in a
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
      label: hasAccountCol ? key || null : (opts.defaultLabel ?? null),
      openingBalance,
      closingBalance,
      transactions: groupRows.map((r) => r.tx),
    }
  })
}

/**
 * Guess the field delimiter from the header line: our exports use ",", but a spreadsheet
 * on a ";"-locale (RO/DE/FR Windows) or a tab-separated save re-writes the file with its
 * own list separator. Counted OUTSIDE quotes so a quoted "file.pdf, page 3" doesn't vote.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 }
  let inQuotes = false
  for (const c of firstLine) {
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && c in counts) counts[c] += 1
  }
  let best = ","
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d
  return best
}

/** Read a quoted TSV cell from `s[start]` (just after the opening quote): `""` is a literal
 * quote; a lone `"` followed by a tab or the end of `s` closes the cell. `closed: false` =
 * the cell continues on the next line (Excel keeps the cell's own newlines). */
function readQuotedCell(s: string, start: number): { content: string; end: number; closed: boolean } {
  let content = ""
  let i = start
  while (i < s.length) {
    const c = s[i]
    if (c === '"') {
      if (s[i + 1] === '"') {
        content += '"'
        i += 2
        continue
      }
      if (i + 1 === s.length || s[i + 1] === "\t") return { content, end: i + 1, closed: true }
      // A stray quote inside the cell \u2014 keep it (lenient).
    }
    content += c
    i++
  }
  return { content, end: i, closed: false }
}

/**
 * Split TAB-separated text into rows \u2014 what Excel puts on the clipboard (Ctrl+C on a range)
 * and writes to a "Text (tab delimited)" file. Its quoting is NOT CSV's (measured on Excel
 * 16, fixtures in `scripts/fixtures/`): a cell is wrapped in quotes ONLY when it contains a
 * tab or a newline (inner quotes then doubled), while a cell that merely contains quotes \u2014
 * even a LEADING one \u2014 is emitted raw: `say "hi" now`, `"leading quote`. `parseCsvRows`
 * would drop the quotes of the first and, on the second, swallow the rest of the paste into
 * one field. So here a `"` is literal unless it opens a cell that (a) closes with `"` + tab/
 * end-of-line on the same line AND holds a tab (why else would Excel have quoted it), or
 * (b) does not close on this line \u2014 a cell spanning lines \u2014 which is told apart from a raw
 * leading quote by the COLUMN COUNT: a line that already carries as many tab-separated
 * fields as the header is a complete row, not the start of a multi-line cell.
 */
export function parseTsvRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop() // the trailing newline
  const width = lines[0].split("\t").length
  const rows: string[][] = []
  let row: string[] = []
  let open: string | null = null // content so far of a cell spanning lines

  for (const line of lines) {
    let pos = 0
    if (open != null) {
      const q = readQuotedCell(line, 0)
      open += "\n" + q.content
      if (!q.closed) continue
      row.push(open)
      open = null
      pos = q.end
      if (pos >= line.length) {
        rows.push(row)
        row = []
        continue
      }
      pos++ // the tab after the closing quote
    }
    for (;;) {
      const nextTab = line.indexOf("\t", pos)
      const rawEnd = nextTab === -1 ? line.length : nextTab
      if (line[pos] === '"') {
        const q = readQuotedCell(line, pos + 1)
        if (q.closed && q.content.includes("\t")) {
          row.push(q.content)
          pos = q.end
          if (pos >= line.length) break
          pos++
          continue
        }
        if (!q.closed) {
          const naiveFields = row.length + line.slice(pos).split("\t").length
          if (naiveFields < width) {
            open = q.content // the cell continues on the next line
            break
          }
        }
        // Otherwise the quote is literal \u2014 fall through.
      }
      row.push(line.slice(pos, rawEnd))
      if (nextTab === -1) break
      pos = nextTab + 1
    }
    if (open == null) {
      rows.push(row)
      row = []
    }
  }
  if (open != null) {
    // Unterminated at the end of the text: keep what was read rather than lose the row.
    row.push(open)
    rows.push(row)
  }
  return rows
}

/**
 * Parse the app's exported transactions as TEXT \u2014 a CSV file, a tab-delimited file, or the
 * rows Excel puts on the clipboard (Ctrl+C \u2192 Ctrl+V in the app) \u2014 into one
 * `ImportedStatement` per account. Tolerates what a spreadsheet does to the data: a
 * leading BOM, a locale list separator, day-first dates, dropped trailing zeros, and the
 * clipboard's own quoting rules (`parseTsvRows`).
 * Throws `CSV_IMPORT_EMPTY` / `CSV_IMPORT_BAD_FORMAT` on unusable text.
 */
export function parseTransactionsCsv(text: string): ImportedStatement[] {
  const body = text.replace(/^\uFEFF/, "") // a UTF-8 BOM ("CSV UTF-8" in Excel) before the first header cell
  const delimiter = detectDelimiter(body)
  const rows = delimiter === "\t" ? parseTsvRows(body) : parseCsvRows(body, delimiter)
  // A ";" list separator goes with a "," decimal separator (that is WHY those locales
  // can't use the comma to separate fields).
  return parseTransactionRows(rows, { decimalComma: delimiter === ";" })
}

// --- Excel workbook -----------------------------------------------------------------

/** One sheet of a workbook as the xlsx reader hands it over: its name and its rows of
 * TYPED cells (string / number / boolean / Date / null). */
export interface WorkbookSheet {
  name: string
  rows: unknown[][]
}

/** The multi-account workbook's all-rows sheet (`app/page.tsx` → `transactionSheet("Combined")`). */
const COMBINED_SHEET = "combined"

/** Excel's day 0 (the 1900 date system, as every modern Excel and our writer use) → a
 * serial number of days is turned into an ISO calendar day. Only needed when a date cell
 * reaches us as a bare number — a row the user typed without a date format. */
function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000) // 25569 = days from 1899-12-30 to 1970-01-01
  return new Date(ms).toISOString().slice(0, 10)
}

/** A typed cell → the string the CSV would have held for that column, so both readers
 * share `parseTransactionRows`. Dates become ISO (UTC parts when the reader gave us UTC
 * midnight, else local parts — either way the calendar day the cell shows). */
function cellToString(value: unknown, column: "date" | "money" | "text"): string {
  if (value == null) return ""
  if (value instanceof Date) {
    const utcMidnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0
    const y = utcMidnight ? value.getUTCFullYear() : value.getFullYear()
    const m = utcMidnight ? value.getUTCMonth() : value.getMonth()
    const d = utcMidnight ? value.getUTCDate() : value.getDate()
    return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  if (typeof value === "number") {
    if (column === "date") return excelSerialToIso(value)
    if (column === "money") return value.toFixed(2)
    return String(value)
  }
  if (typeof value === "boolean") return ""
  return String(value)
}

/** Convert one sheet's typed rows to CSV-shaped strings, column by column (the header
 * decides which cells are dates / money). */
function sheetToRows(sheet: WorkbookSheet): string[][] {
  const header = (sheet.rows[0] ?? []).map((c) => (c == null ? "" : String(c)))
  const cols = columnsOf(header)
  const kind = (i: number): "date" | "money" | "text" =>
    i === cols.date ? "date" : i === cols.debit || i === cols.credit || i === cols.balance ? "money" : "text"
  return [header, ...sheet.rows.slice(1).map((r) => r.map((c, i) => cellToString(c, kind(i))))]
}

/**
 * Parse the app's exported Excel workbook (every sheet, as typed rows) into one
 * `ImportedStatement` per account. Which sheet(s) carry the transactions:
 *   - a sheet named "Combined" (the multi-account workbook: every row + the Account
 *     column) is read alone — that is where the user edits categories;
 *   - otherwise the ONE sheet with a transactions header (a single-statement workbook, or
 *     a CSV the user saved as .xlsx);
 *   - otherwise EVERY such sheet (a multi-account workbook whose Combined sheet was
 *     deleted) — each account sheet becomes an account labelled by its Account column or,
 *     failing that, its sheet name. Never silently drop accounts.
 * Sheets without Date/Debit/Credit (Summary, Expenses, anything else) are ignored.
 */
export function parseTransactionsWorkbook(sheets: WorkbookSheet[]): ImportedStatement[] {
  const candidates = sheets.filter((s) => {
    const header = (s.rows[0] ?? []).map((c) => (c == null ? "" : String(c)))
    return isTransactionsHeader(columnsOf(header))
  })
  if (candidates.length === 0) throw new Error(CSV_IMPORT_BAD_FORMAT)

  const combined = candidates.find((s) => s.name.trim().toLowerCase() === COMBINED_SHEET)
  if (combined) return parseTransactionRows(sheetToRows(combined))
  if (candidates.length === 1) return parseTransactionRows(sheetToRows(candidates[0]))

  const all: ImportedStatement[] = []
  for (const s of candidates) {
    try {
      all.push(...parseTransactionRows(sheetToRows(s), { defaultLabel: s.name }))
    } catch (e) {
      // An empty account sheet is not an error for the workbook — skip it.
      if (!(e instanceof Error && e.message === CSV_IMPORT_EMPTY)) throw e
    }
  }
  if (all.length === 0) throw new Error(CSV_IMPORT_EMPTY)
  return all
}

// --- Per-statement breakdown ------------------------------------------------------

/**
 * Rebuild the per-statement breakdown (one entry per ORIGINAL PDF: file · transactions ·
 * period · balance range) from the imported rows' `sourceFile`, so an imported account
 * shows the statements it was made of — not the name of the CSV/xlsx it was loaded from.
 * Rows are grouped in first-seen (statement) order; each group's opening/closing come
 * from its running balance like the whole account's. Rows with no source are skipped:
 * returns [] when none carries one (the caller then falls back to the import file).
 */
export function statementsFromSources(transactions: Transaction[]): PerFileResult[] {
  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (!t.sourceFile) continue
    const list = groups.get(t.sourceFile)
    if (list) list.push(t)
    else groups.set(t.sourceFile, [t])
  }
  return [...groups].map(([fileName, rows]) => {
    const dates = rows.map((t) => t.date).filter((d): d is string => !!d).sort()
    const { openingBalance, closingBalance } = deriveOpeningClosing(
      rows.map((t) => ({
        debitCents: toCents(t.debit),
        creditCents: toCents(t.credit),
        balanceCents: t.balance == null ? null : toCents(t.balance),
      })),
    )
    return {
      fileName,
      transactionCount: rows.length,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      openingBalance,
      closingBalance,
    }
  })
}

/** The `StatementData` shape of an imported account (what `checkReconciliation` takes). */
export function importedToStatement(a: ImportedStatement, bank: string): StatementData {
  return {
    bank,
    openingBalance: a.openingBalance,
    closingBalance: a.closingBalance,
    transactions: a.transactions,
  }
}
