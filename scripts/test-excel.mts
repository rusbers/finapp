/**
 * Headless test for the Excel export (lib/core/excel.ts). Pure asserts on the sheet
 * builders — no PDF, no AI, no browser — plus a Node smoke test that the xlsx library
 * accepts the cell shapes we produce (so the browser wiring can't be handed something
 * it would choke on).
 *
 * Usage: npm run test:excel
 */

import writeExcelFile from "write-excel-file/node"
import { transactionSheet, summarySheet, expensesSheet, sheetName, DATE_FORMAT, MONEY_FORMAT, type XlsxCell } from "../lib/core/excel"
import { toCsv } from "../lib/core/verification"
import { expensesReportToCsv, expensesReportRows, type ExpenseReport } from "../lib/core/expenses"
import type { StatementData } from "../lib/core/types"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}
const obj = (c: XlsxCell) => (c !== null && typeof c === "object" ? c : null)
const text = (c: XlsxCell) => (typeof c === "string" ? c : (obj(c)?.value as string | undefined) ?? "")

// ---------------------------------------------------------------------------
// 1. transactionSheet — same columns as toCsv, but typed cells.
// ---------------------------------------------------------------------------
const single: StatementData = {
  bank: "BOI",
  openingBalance: 100,
  closingBalance: 130.5,
  transactions: [
    { date: "2024-01-05", description: "Opening deposit", debit: 0, credit: 50, balance: 150, category: "Top-up", sourceFile: "stmt.pdf", page: 1 },
    { date: "2024-01-10", description: "Coffee, milk", debit: 19.5, credit: 0, balance: null, page: 1 },
    { date: "not a date", description: "Odd AI row", debit: 0, credit: 20, balance: null },
    { date: "2024-01-20", description: "Rent", debit: 20, credit: 0, balance: 130.5, page: 2 },
  ],
}
const sh = transactionSheet("BOI", single, { defaultSource: "stmt.pdf" })
const csvHeader = toCsv(single, { rowNumbers: true }).split("\n")[0].split(",")
check("sheet header = CSV header (no Account column when no row is labelled)", sh.rows[0].map(text).join(",") === csvHeader.join(","))
check("header cells are bold", sh.rows[0].every((c) => obj(c)?.fontWeight === "bold"))
check("header row is frozen", sh.stickyRowsCount === 1)
check("one column width per column", sh.columns?.length === sh.rows[0].length)
check("rows = transactions + header", sh.rows.length === 5)

const r1 = sh.rows[1]
check("# is a number (1-based)", r1[0] === 1)
const d1 = obj(r1[1])
check("Date is a Date cell at UTC midnight", d1?.type === Date && (d1?.value as Date).toISOString() === "2024-01-05T00:00:00.000Z")
check("Date cell carries the day-first format", d1?.format === DATE_FORMAT)
check("Debit 0 → blank cell", r1[3] === null)
const c1 = obj(r1[4])
check("Credit is a money number", c1?.type === Number && c1?.value === 50 && c1?.format === MONEY_FORMAT)
check("Balance is a money number", obj(r1[5])?.value === 150)
check("Category text", r1[6] === "Top-up")
check("Source = file + page (own sourceFile)", r1[7] === "stmt.pdf, page 1")

const r2 = sh.rows[2]
check("Description with a comma is plain text (no CSV quoting)", r2[2] === "Coffee, milk")
check("Debit 19.5 is a number", obj(r2[3])?.value === 19.5)
check("null balance → blank cell", r2[5] === null)
check("Source falls back to defaultSource", r2[7] === "stmt.pdf, page 1")
check("empty category → empty text", r2[6] === "")

check("non-ISO date stays as text", sh.rows[3][1] === "not a date")
check("row without page → Source is just the file", sh.rows[3][7] === "stmt.pdf")

// Account column appears when any row is labelled (multi-account / stamped rows).
const labelled: StatementData = {
  ...single,
  transactions: single.transactions.map((t) => ({ ...t, accountLabel: "BOI" })),
}
const shL = transactionSheet("BOI", labelled)
check("Account column prepended when rows carry accountLabel", text(shL.rows[0][0]) === "Account" && shL.rows[1][0] === "BOI" && shL.rows[1][1] === 1)
check("widths grow with the Account column", shL.columns?.length === shL.rows[0].length)

// ---------------------------------------------------------------------------
// 2. summarySheet
// ---------------------------------------------------------------------------
const sum = summarySheet([
  { label: "BOI", bank: "Bank of Ireland", transactionCount: 12, openingBalance: 100, closingBalance: 130.5, passed: true },
  { label: "Revolut EUR", bank: "Revolut", currency: "EUR", transactionCount: 0, openingBalance: 0, closingBalance: 0, passed: true },
  { label: "AIB", bank: "AIB", transactionCount: 3, openingBalance: 10, closingBalance: 5, passed: false },
])
check("summary: 7 columns, 3 accounts", sum.rows[0].length === 7 && sum.rows.length === 4)
check("summary: ✓ / — / ✗", sum.rows[1][6] === "✓" && sum.rows[2][6] === "—" && sum.rows[3][6] === "✗")
check("summary: balances are money numbers", obj(sum.rows[1][5])?.value === 130.5 && obj(sum.rows[1][5])?.format === MONEY_FORMAT)

// ---------------------------------------------------------------------------
// 3. expensesSheet — the SAME rows as the CSV, Days typed as a number.
// ---------------------------------------------------------------------------
const rawHeader = ["Supplier", "Description", "Category", "Date", "Amount", "VAT", "Link"]
const report: ExpenseReport = {
  total: 2,
  foundCount: 1,
  matches: [
    {
      expense: { supplier: "Screwfix", description: "Drill", category: "Tools", date: "2024-03-01", amount: 99.99, amountCents: 9999, link: "https://x/1", raw: ["Screwfix", "Drill", "Tools", "01/03/2024", "99.99", "23%", "https://x/1"], rawHeader },
      found: true, matchedDate: "2024-03-03", matchedAccount: "BOI", matchedDescription: "SCREWFIX BLANCH", matchedDayGap: 2, matchedSourceFile: "boi.pdf", matchedPage: 3,
    },
    {
      expense: { supplier: "Cash shop", description: "Misc", category: "Other", date: "2024-03-05", amount: 10, amountCents: 1000, raw: ["Cash shop", "Misc", "Other", "05/03/2024", "10.00"], rawHeader },
      found: false,
    },
  ],
}
const ex = expensesSheet(report)
const { header: exHeader, rows: exRows } = expensesReportRows(report)
check("expenses: header = CSV header (original columns + 6 appended)", ex.rows[0].map(text).join("|") === exHeader.join("|") && exHeader.length === rawHeader.length + 6)
check("expenses: original cells verbatim as text", ex.rows[1].slice(0, 7).join("|") === "Screwfix|Drill|Tools|01/03/2024|99.99|23%|https://x/1")
check("expenses: Days is a number", ex.rows[1][exHeader.length - 2] === 2)
check("expenses: Source appended", ex.rows[1][exHeader.length - 1] === "boi.pdf, page 3")
check("expenses: short row padded, not-found Days blank", ex.rows[2][6] === "" && ex.rows[2][exHeader.length - 2] === "" && ex.rows[2][7] === "not found")
check("expenses: every sheet row equals the CSV row (Days aside)", ex.rows.slice(1).every((r, i) => r.map((c) => String(c ?? "")).join("|") === exRows[i].join("|")))
check("expensesReportToCsv still = header + rows joined", expensesReportToCsv(report).split("\n").length === 3 && expensesReportToCsv(report).startsWith("Supplier,Description,Category,Date,Amount,VAT,Link,Found,"))

// ---------------------------------------------------------------------------
// 4. sheetName — Excel's rules.
// ---------------------------------------------------------------------------
const used = new Set<string>()
check("sheetName strips forbidden characters", sheetName("Revolut [EUR]: a/b?*\\", used) === "Revolut EUR ab")
check("sheetName caps at 31 chars", sheetName("A".repeat(40), used) === "A".repeat(31))
check("sheetName dedupes with a suffix within the cap", sheetName("A".repeat(40), used) === "A".repeat(27) + " (2)")
check("sheetName numbers a plain duplicate", sheetName("BOI", used) === "BOI" && sheetName("BOI", used) === "BOI (2)" && sheetName("BOI", used) === "BOI (3)")
check("sheetName never returns empty", sheetName("[]", used) === "Sheet")

// ---------------------------------------------------------------------------
// 5. Smoke: the library accepts these sheets and produces a ZIP (xlsx) buffer.
// ---------------------------------------------------------------------------
const buf = await writeExcelFile(
  [sh, shL, sum, ex].map((s) => ({ data: s.rows, sheet: s.name, columns: s.columns, stickyRowsCount: s.stickyRowsCount })),
).toBuffer()
check("write-excel-file builds a workbook from our sheets", buf.length > 1000)
check("output is a ZIP container (PK magic)", buf[0] === 0x50 && buf[1] === 0x4b)

console.log(`\n${failures === 0 ? "All Excel-export checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
