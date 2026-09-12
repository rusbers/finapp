/**
 * Headless test for the transactions-CSV importer (lib/core/csv-import.ts) — the
 * inverse of `toCsv`. Pure asserts, no PDF/AI. Guarantees the export → import round
 * trip is faithful and that reconciliation stays a REAL check on the reconstructed data.
 *
 * Also covers the Excel (.xlsx) reader path — the app's own workbook written by
 * `write-excel-file` and read back by `read-excel-file` (both in Node here, the same
 * libraries as the browser), plus real files Excel itself saved (scripts/fixtures/).
 *
 * Usage: npm run test:csv-import
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import writeExcelFile from "write-excel-file/node"
import readXlsxFile from "read-excel-file/node"
import {
  parseTransactionsCsv,
  parseTransactionsWorkbook,
  parseTsvRows,
  statementsFromSources,
  CSV_IMPORT_BAD_FORMAT,
  type ImportedStatement,
  type WorkbookSheet,
} from "../lib/core/csv-import"
import { toCsv } from "../lib/core/verification"
import { checkReconciliation } from "../lib/core/reconciliation"
import { parseExpensesCsv, matchExpenses, normalizeDate, EXPENSE_CATEGORY, type MatchEntry } from "../lib/core/expenses"
import { transactionSheet, summarySheet, expensesSheet, DATE_FORMAT, type XlsxSheet } from "../lib/core/excel"
import type { StatementData, Transaction } from "../lib/core/types"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}
const moneyEq = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100)
const passes = (d: StatementData) => checkReconciliation(d).passed

// ---------------------------------------------------------------------------
// 1 + 2. Single statement round-trip (categories, sourceFile, page, sporadic
//        balances, a comma-bearing description AND a comma-bearing Source cell).
// ---------------------------------------------------------------------------
const single: StatementData = {
  bank: "BOI",
  openingBalance: 100,
  closingBalance: 130.5,
  transactions: [
    { date: "2024-01-05", description: "Opening deposit", debit: 0, credit: 50, balance: 150, category: "Top-up", sourceFile: "stmt.pdf", page: 1 },
    { date: "2024-01-10", description: "Coffee, milk", debit: 19.5, credit: 0, balance: null, sourceFile: "stmt.pdf", page: 1 },
    { date: "2024-01-15", description: "Refund", debit: 0, credit: 20, balance: null, sourceFile: "stmt.pdf", page: 2 },
    { date: "2024-01-20", description: "Rent", debit: 20, credit: 0, balance: 130.5, sourceFile: "stmt.pdf", page: 2 },
  ],
}
const singleCsv = toCsv(single, { rowNumbers: true, defaultSource: "stmt.pdf" })
const imp1 = parseTransactionsCsv(singleCsv)

console.log("# 1-2. Single round-trip")
check("one reconstructed statement (no distinct accounts)", imp1.length === 1)
const st1 = imp1[0]
check("opening derived from first printed balance (100)", moneyEq(st1.openingBalance, 100))
check("closing derived from last printed balance (130.50)", moneyEq(st1.closingBalance, 130.5))
check("reconstructed statement reconciles", passes({ bank: "BOI", ...st1 }))
check("row count preserved", st1.transactions.length === 4)
const fieldsEqual = single.transactions.every((orig, i) => {
  const t = st1.transactions[i]
  return (
    t.date === orig.date &&
    t.description === orig.description &&
    moneyEq(t.debit, orig.debit) &&
    moneyEq(t.credit, orig.credit) &&
    (t.balance == null ? orig.balance == null : orig.balance != null && moneyEq(t.balance, orig.balance)) &&
    (t.category ?? undefined) === (orig.category ?? undefined) &&
    t.sourceFile === orig.sourceFile &&
    t.page === orig.page
  )
})
check("every field round-trips (date/desc/debit/credit/balance/category/sourceFile/page)", fieldsEqual)
check("comma-bearing description survived quoting", st1.transactions[1].description === "Coffee, milk")
check("quoted Source split back into file + page", st1.transactions[0].sourceFile === "stmt.pdf" && st1.transactions[0].page === 1)
check("sporadic (blank) balances round-trip to null", st1.transactions[1].balance === null && st1.transactions[2].balance === null)

// ---------------------------------------------------------------------------
// 3. Multi-account: a combined CSV (Account column) → one statement per account.
// ---------------------------------------------------------------------------
const combined: StatementData = {
  bank: "combined",
  openingBalance: 0,
  closingBalance: 0,
  transactions: [
    { date: "2024-01-02", description: "AIB in", debit: 0, credit: 100, balance: 100, sourceFile: "aib.pdf", page: 3, accountLabel: "AIB" },
    { date: "2024-01-03", description: "Rev in", debit: 0, credit: 5, balance: 15, sourceFile: "rev.pdf", accountLabel: "Revolut" },
    { date: "2024-01-05", description: "POS SCREWFIX BLANCH", debit: 40, credit: 0, balance: 60, sourceFile: "aib.pdf", page: 4, accountLabel: "AIB" },
    { date: "2024-01-06", description: "Rev out", debit: 5, credit: 0, balance: 10, sourceFile: "rev.pdf", accountLabel: "Revolut" },
  ],
}
const combinedCsv = toCsv(combined, { rowNumbers: true })
const imp3 = parseTransactionsCsv(combinedCsv)

console.log("\n# 3. Multi-account split")
check("two reconstructed accounts", imp3.length === 2)
const aib = imp3.find((a) => a.label === "AIB")
const rev = imp3.find((a) => a.label === "Revolut")
check("labels are AIB + Revolut", !!aib && !!rev)
check("AIB: opening 0, closing 60, reconciles", !!aib && moneyEq(aib.openingBalance, 0) && moneyEq(aib.closingBalance, 60) && passes({ bank: "AIB", ...aib }))
check("Revolut: opening 10, closing 10, reconciles", !!rev && moneyEq(rev.openingBalance, 10) && moneyEq(rev.closingBalance, 10) && passes({ bank: "Revolut", ...rev }))
check("each account keeps only its own rows", !!aib && aib.transactions.length === 2 && !!rev && rev.transactions.length === 2)

// ---------------------------------------------------------------------------
// 4. "#"-reorder robustness: shuffle data lines, the parser restores order.
// ---------------------------------------------------------------------------
const lines = singleCsv.split("\n")
const shuffled = [lines[0], ...lines.slice(1).reverse()].join("\n")
const imp4 = parseTransactionsCsv(shuffled)
console.log("\n# 4. #-reorder robustness")
check("reordered CSV still reconstructs one statement", imp4.length === 1)
check("statement order restored from # (first row is the opening deposit)", imp4[0].transactions[0].description === "Opening deposit")
check("opening/closing correct despite reorder + reconciles", moneyEq(imp4[0].openingBalance, 100) && moneyEq(imp4[0].closingBalance, 130.5) && passes({ bank: "BOI", ...imp4[0] }))

// ---------------------------------------------------------------------------
// 5. Edited/inconsistent CSV: change one Debit but not the balances → FAILS.
// ---------------------------------------------------------------------------
const edited = singleCsv.replace(",20.00,,130.50,", ",25.00,,130.50,") // Rent 20.00 → 25.00, balance untouched
console.log("\n# 5. Edited CSV is caught")
check("the edit actually changed the text", edited !== singleCsv)
const imp5 = parseTransactionsCsv(edited)
check("an inconsistent (hand-edited) CSV FAILS reconciliation", !passes({ bank: "BOI", ...imp5[0] }))

// ---------------------------------------------------------------------------
// 6. No Balance column at all → opening 0, trivial reconcile, rows still parsed.
// ---------------------------------------------------------------------------
const noBalCsv = "Date,Description,Debit,Credit\n2024-02-01,A,,50.00\n2024-02-02,B,30.00,\n"
const imp6 = parseTransactionsCsv(noBalCsv)
console.log("\n# 6. No Balance column")
check("parses without a Balance column", imp6.length === 1 && imp6[0].transactions.length === 2)
check("opening 0, closing = Σ(credit−debit) (20), reconciles", moneyEq(imp6[0].openingBalance, 0) && moneyEq(imp6[0].closingBalance, 20) && passes({ bank: "x", ...imp6[0] }))
check("balances are null when the column is absent", imp6[0].transactions.every((t) => t.balance === null))

// ---------------------------------------------------------------------------
// 7. Expense matching over reconstructed accounts (account + source attributed).
// ---------------------------------------------------------------------------
const entries: MatchEntry[] = imp3.flatMap((a) =>
  a.transactions.map((tx) => ({ tx, account: a.label ?? undefined })),
)
const expensesCsv =
  "Supplier,Description,Category,Date,Amount\n" +
  "Screwfix,tools,Repairs,2024-01-04,40.00\n" + // exact 40 + name in "POS SCREWFIX BLANCH" + within 5 days
  "Ghost,nothing,Misc,2024-01-04,999.00\n" // no matching debit
const report = matchExpenses(parseExpensesCsv(expensesCsv), entries)
console.log("\n# 7. Expense matching on reconstructed accounts")
check("2 expenses, 1 found", report.total === 2 && report.foundCount === 1)
const found = report.matches.find((m) => m.found)
check("matched to the AIB account", !!found && found.matchedAccount === "AIB")
check("matched debit's source file recovered", !!found && found.matchedSourceFile === "aib.pdf" && found.matchedPage === 4)
check("the 999 expense is not found", report.matches.some((m) => !m.found && m.expense.supplier === "Ghost"))

// ---------------------------------------------------------------------------
// 8. An expenses.csv (no debit/credit) is rejected as a transactions CSV.
// ---------------------------------------------------------------------------
console.log("\n# 8. Rejects a non-transactions CSV")
let threw = ""
try {
  parseTransactionsCsv(expensesCsv)
} catch (e) {
  threw = e instanceof Error ? e.message : String(e)
}
check("throws CSV_IMPORT_BAD_FORMAT on an expenses.csv", threw === CSV_IMPORT_BAD_FORMAT)

// ---------------------------------------------------------------------------
// 9. What Excel (en-GB) does to our CSV on "Save As → CSV UTF-8": a BOM before the
//    first header cell, dates re-written day-first (05/01/2025), trailing zeros
//    dropped (19.5), CRLF. Real file, produced by Excel 16 via COM from `csvSix` below.
// ---------------------------------------------------------------------------
const six: StatementData = {
  bank: "combined",
  openingBalance: 0,
  closingBalance: 0,
  transactions: [
    { date: "2025-01-05", description: "POS SCREWFIX BLANCH", debit: 19.5, credit: 0, balance: 980.5, category: "Tools", sourceFile: "boi-jan.pdf", page: 1, accountLabel: "BOI" },
    { date: "2025-01-10", description: 'Coffee, milk "corner"', debit: 4.2, credit: 0, balance: null, sourceFile: "boi-jan.pdf", page: 1, accountLabel: "BOI" },
    { date: "2025-02-01", description: "SALARY ACME LTD", debit: 0, credit: 1234.56, balance: 2210.86, category: "Income", sourceFile: "boi-feb.pdf", page: 2, accountLabel: "BOI" },
    { date: "2025-02-14", description: "TRANSFER TO REVOLUT", debit: 1200.36, credit: 0, balance: 1010.5, category: "Transfer", sourceFile: "boi-feb.pdf", page: 3, accountLabel: "BOI" },
    { date: "2025-01-06", description: "Tesco Mobile", debit: 20, credit: 0, balance: 480, category: "Telecom", sourceFile: "revolut.pdf", page: 5, accountLabel: "Revolut" },
    { date: "2025-01-20", description: "Top-Up 1,000.00 EUR", debit: 0, credit: 1000, balance: 1480, sourceFile: "revolut.pdf", page: 6, accountLabel: "Revolut" },
  ],
}
const csvSix = toCsv(six, { rowNumbers: true, defaultSource: "fallback.pdf" })
const expectedSix = parseTransactionsCsv(csvSix)
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/** Deep-compare two import results field by field (what the user would see). */
const sameImport = (a: ImportedStatement[], b: ImportedStatement[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]
    return (
      x.label === y.label &&
      moneyEq(x.openingBalance, y.openingBalance) &&
      moneyEq(x.closingBalance, y.closingBalance) &&
      x.transactions.length === y.transactions.length &&
      x.transactions.every((t, k) => {
        const u = y.transactions[k]
        return (
          t.date === u.date &&
          t.description === u.description &&
          moneyEq(t.debit, u.debit) &&
          moneyEq(t.credit, u.credit) &&
          (t.balance == null ? u.balance == null : u.balance != null && moneyEq(t.balance, u.balance)) &&
          (t.category ?? undefined) === (u.category ?? undefined) &&
          t.sourceFile === u.sourceFile &&
          t.page === u.page &&
          t.accountLabel === u.accountLabel
        )
      })
    )
  })

console.log("\n# 9. Excel-saved CSV (BOM, day-first dates, dropped zeros)")
const excelCsvText = readFileSync(fixture("excel-saved-export-utf8.csv"), "utf8")
check("fixture starts with a BOM and day-first dates", excelCsvText.charCodeAt(0) === 0xfeff && /\r\n[^\n]*,05\/01\/2025,/.test(excelCsvText))
const imp9 = parseTransactionsCsv(excelCsvText)
check("two accounts recovered (BOM did not hide the Account column)", imp9.length === 2 && imp9[0].label === "BOI" && imp9[1].label === "Revolut")
check("identical to importing our own CSV (dates, cents, categories, source+page)", sameImport(imp9, expectedSix))
check("both accounts still reconcile", imp9.every((a) => passes({ bank: a.label ?? "x", ...a })))
check("normalizeDate also reads dd.mm.yyyy and dd-mm-yyyy", normalizeDate("05.01.2025") === "2025-01-05" && normalizeDate("5-1-2025") === "2025-01-05")

// ---------------------------------------------------------------------------
// 10. A ";"-locale spreadsheet (RO/DE): ";" list separator AND "," decimal separator.
// ---------------------------------------------------------------------------
const semi = csvSix
  .split("\n")
  .map((line, i) => {
    if (i === 0) return line.replace(/,/g, ";")
    // Quote-aware: only the field separators become ";", then the decimal dots of the
    // three money fields (Debit/Credit/Balance) become ",".
    const fields: string[] = []
    let f = ""
    let q = false
    for (const c of line) {
      if (c === '"') {
        q = !q
        f += c
      } else if (c === "," && !q) {
        fields.push(f)
        f = ""
      } else f += c
    }
    fields.push(f)
    return fields.map((v, k) => (k >= 4 && k <= 6 ? v.replace(".", ",") : v)).join(";")
  })
  .join("\r\n")
console.log("\n# 10. ';'-delimited CSV with decimal commas")
check("fixture uses ; and decimal commas", semi.includes(";19,50;") && semi.includes('"boi-jan.pdf, page 1"'))
check("imports identically to the comma version", sameImport(parseTransactionsCsv(semi), expectedSix))

// ---------------------------------------------------------------------------
// 11. Excel round trip through the SAME libraries the app uses: our transactionSheet →
//     write-excel-file → read-excel-file → parseTransactionsWorkbook.
// ---------------------------------------------------------------------------
const toWorkbook = async (sheets: XlsxSheet[]): Promise<WorkbookSheet[]> => {
  const buf = await writeExcelFile(
    sheets.map((s) => ({ data: s.rows, sheet: s.name, columns: s.columns, stickyRowsCount: s.stickyRowsCount })),
  ).toBuffer()
  const read = await readXlsxFile(buf, { dateFormat: DATE_FORMAT })
  return read.map((s) => ({ name: s.sheet, rows: s.data }))
}
console.log("\n# 11. xlsx round trip (single sheet)")
const wb11 = await toWorkbook([transactionSheet("BOI", single, { defaultSource: "stmt.pdf" })])
const dateCol = (wb11[0].rows[0] as string[]).indexOf("Date")
check("date cells come back typed (Date), not text", wb11[0].rows[1][dateCol] instanceof Date)
const imp11 = parseTransactionsWorkbook(wb11)
check("one statement, reconciles, opening/closing as from the CSV", imp11.length === 1 && passes({ bank: "BOI", ...imp11[0] }) && moneyEq(imp11[0].openingBalance, 100) && moneyEq(imp11[0].closingBalance, 130.5))
check("every field identical to the CSV import (date/desc/debit/credit/balance/category/source/page)", sameImport(imp11, imp1))

// ---------------------------------------------------------------------------
// 12. The multi-account workbook: Summary + Combined + per-account sheets + Expenses.
//     Combined is read; Summary/Expenses are ignored; per-account sheets are the
//     fallback when Combined was deleted (labelled by Account column or sheet name).
// ---------------------------------------------------------------------------
const aibOnly = combined.transactions.filter((t) => t.accountLabel === "AIB")
const revOnly = combined.transactions.filter((t) => t.accountLabel === "Revolut")
const summary = summarySheet([
  { label: "AIB", bank: "AIB", transactionCount: 2, openingBalance: 0, closingBalance: 60, passed: true },
  { label: "Revolut", bank: "Revolut", transactionCount: 2, openingBalance: 10, closingBalance: 10, passed: true },
])
const expensesReport = matchExpenses(parseExpensesCsv("Supplier,Description,Category,Date,Amount\nGhost,x,Misc,2024-01-04,999.00\n"), [])
const fullWb = await toWorkbook([
  summary,
  transactionSheet("Combined", combined),
  transactionSheet("AIB", { ...combined, transactions: aibOnly }),
  transactionSheet("Revolut", { ...combined, transactions: revOnly }),
  expensesSheet(expensesReport),
])
console.log("\n# 12. Multi-account workbook")
// A fresh parse of the combined CSV: `imp3` was mutated by the expense matching in §7.
const freshCombined = parseTransactionsCsv(combinedCsv)
check("workbook has the five sheets", fullWb.map((s) => s.name).join(",") === "Summary,Combined,AIB,Revolut,Expenses")
const imp12 = parseTransactionsWorkbook(fullWb)
check("Combined sheet → two accounts, identical to the combined-CSV import", sameImport(imp12, freshCombined))
const noCombined = fullWb.filter((s) => s.name !== "Combined")
const imp12b = parseTransactionsWorkbook(noCombined)
check("without Combined: every account sheet read (2 accounts), Summary/Expenses ignored", imp12b.length === 2 && sameImport(imp12b, freshCombined))
// Per-account sheets whose rows carry no Account column → the sheet name labels the account.
const strip = (txs: Transaction[]) => txs.map((t) => ({ ...t, accountLabel: undefined }))
const bareWb = await toWorkbook([
  summary,
  transactionSheet("AIB", { ...combined, transactions: strip(aibOnly) }),
  transactionSheet("Revolut", { ...combined, transactions: strip(revOnly) }),
])
const imp12c = parseTransactionsWorkbook(bareWb)
check("no Account column → accounts labelled by sheet name", imp12c.length === 2 && imp12c[0].label === "AIB" && imp12c[1].label === "Revolut")
let threw12 = ""
try {
  parseTransactionsWorkbook([summary, expensesSheet(expensesReport)].map((s) => ({ name: s.name, rows: s.rows })))
} catch (e) {
  threw12 = e instanceof Error ? e.message : String(e)
}
check("a workbook with no transactions sheet is rejected (bad format)", threw12 === CSV_IMPORT_BAD_FORMAT)

// ---------------------------------------------------------------------------
// 13. A workbook Excel ITSELF saved (the user opened our CSV and chose .xlsx): Excel
//     typed the dates and numbers on its own. Real file from Excel 16 via COM.
// ---------------------------------------------------------------------------
console.log("\n# 13. Excel-saved .xlsx")
const excelWb = await readXlsxFile(readFileSync(fixture("excel-saved-export.xlsx")))
const imp13 = parseTransactionsWorkbook(excelWb.map((s) => ({ name: s.sheet, rows: s.data })))
check("Excel-typed dates/numbers import identically to our CSV", sameImport(imp13, expectedSix))
check("both accounts reconcile", imp13.every((a) => passes({ bank: a.label ?? "x", ...a })))

// ---------------------------------------------------------------------------
// 14. Expense matching on imported rows keeps the user's categories: a matched debit
//     that already has a category keeps it; one without gets the "Expenses" marker.
// ---------------------------------------------------------------------------
console.log("\n# 14. Categories survive expense matching")
const imp14 = parseTransactionsCsv(csvSix)
const entries14: MatchEntry[] = imp14.flatMap((a) => a.transactions.map((tx) => ({ tx, account: a.label ?? undefined })))
const report14 = matchExpenses(
  parseExpensesCsv(
    "Supplier,Description,Category,Date,Amount\n" +
      "Screwfix,tools,Repairs,2025-01-04,19.50\n" + // matches the categorised "Tools" row
      "Coffee corner,coffee,Food,2025-01-10,4.20\n", // matches the UNcategorised coffee row
  ),
  entries14,
)
check("both expenses found", report14.foundCount === 2)
const screwfix = entries14.find((e) => e.tx.description === "POS SCREWFIX BLANCH")!.tx
const coffee = entries14.find((e) => e.tx.description.startsWith("Coffee"))!.tx
check("a categorised row keeps its own category (Tools, not the marker)", screwfix.category === "Tools")
check("an uncategorised row gets the marker", coffee.category === EXPENSE_CATEGORY)

// ---------------------------------------------------------------------------
// 15. Per-statement breakdown rebuilt from the rows' Source (the original PDFs).
// ---------------------------------------------------------------------------
console.log("\n# 15. statementsFromSources")
const boiRows = expectedSix[0].transactions
const per15 = statementsFromSources(boiRows)
check("one entry per source PDF, in statement order", per15.map((p) => p.fileName).join(",") === "boi-jan.pdf,boi-feb.pdf")
check("counts + periods per PDF", per15[0].transactionCount === 2 && per15[0].periodStart === "2025-01-05" && per15[0].periodEnd === "2025-01-10" && per15[1].transactionCount === 2 && per15[1].periodEnd === "2025-02-14")
check("balance range per PDF from its running balance (jan: 1000 → 976.30; feb: 976.30 → 1010.50)", moneyEq(per15[0].openingBalance, 1000) && moneyEq(per15[0].closingBalance, 976.3) && moneyEq(per15[1].openingBalance, 976.3) && moneyEq(per15[1].closingBalance, 1010.5))
check("rows without a Source → no entries (caller falls back to the import file)", statementsFromSources(imp6[0].transactions).length === 0)

// ---------------------------------------------------------------------------
// 16. Excel's CLIPBOARD (Ctrl+C on the rows → Ctrl+V in the app): tab-separated, CRLF,
//     dates/numbers as displayed, and Excel's own quoting — a cell is quoted ONLY when it
//     holds a tab or a newline; quotes inside other cells are emitted raw, even a leading
//     one. Real clipboard text captured from Excel 16 via COM (scripts/fixtures/).
// ---------------------------------------------------------------------------
console.log("\n# 16. Excel clipboard (TSV)")
const clip = readFileSync(fixture("excel-clipboard-export.tsv"), "utf8")
check("fixture is tab-separated with raw quotes in a cell", clip.includes("\t") && clip.includes('\tCoffee, milk "corner"\t'))
check("pasted rows import identically to our own CSV (quotes in the description kept)", sameImport(parseTransactionsCsv(clip), expectedSix))

const edge = readFileSync(fixture("excel-clipboard-edge.tsv"), "utf8")
const rows16 = parseTsvRows(edge)
check("edge fixture: header + 5 rows, 3 columns each", rows16.length === 6 && rows16.every((r) => r.length === 3))
const descs = rows16.slice(1).map((r) => r[1])
check("multi-line cell (quoted by Excel) rejoined with its newline", descs[0] === "line one\nline two")
check("quotes inside a cell are literal (Excel emits them raw)", descs[1] === 'say "hi" now')
check("a cell holding a tab (quoted by Excel) keeps the tab", descs[2] === "tab\tinside")
check("a raw LEADING quote does not swallow the following rows", descs[3] === '"leading quote')
check("doubled quotes + comma + newline inside a quoted cell", descs[4] === 'a "quoted", comma\nx')
check("the debits after each of those cells are intact", rows16.slice(1).map((r) => r[2]).join(",") === "1.5,2,3,4,5")
// (This probe sheet has no Credit column, so as a transactions import it is correctly
// rejected — what matters here is the cell splitting above.)
let threw16 = ""
try {
  parseTransactionsCsv(edge)
} catch (e) {
  threw16 = e instanceof Error ? e.message : String(e)
}
check("a tab-separated paste without Debit/Credit is rejected as bad format", threw16 === CSV_IMPORT_BAD_FORMAT)

console.log(`\n${failures === 0 ? "All CSV-import checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
