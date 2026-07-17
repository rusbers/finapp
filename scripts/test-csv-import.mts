/**
 * Headless test for the transactions-CSV importer (lib/core/csv-import.ts) — the
 * inverse of `toCsv`. Pure asserts, no PDF/AI. Guarantees the export → import round
 * trip is faithful and that reconciliation stays a REAL check on the reconstructed data.
 *
 * Usage: npm run test:csv-import
 */

import { parseTransactionsCsv, CSV_IMPORT_BAD_FORMAT } from "../lib/core/csv-import"
import { toCsv } from "../lib/core/verification"
import { checkReconciliation } from "../lib/core/reconciliation"
import { parseExpensesCsv, matchExpenses, type MatchEntry } from "../lib/core/expenses"
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

console.log(`\n${failures === 0 ? "All CSV-import checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
