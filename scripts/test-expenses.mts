/**
 * Headless test for expense reconciliation.
 *   1. SYNTHETIC asserts for parseExpensesCsv + matchExpenses (deterministic, no PDFs).
 *   2. REAL case(s) under statements/expenses-reconciliation/<n>/ — extract the
 *      statements (deterministic parsers), read expenses.csv, match, and print the
 *      found rate + a sample of not-found expenses for inspection (soft, not asserted).
 *
 * Usage: npm run test:expenses
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  parseExpensesCsv,
  matchExpenses,
  expensesReportToCsv,
  nameMatches,
  type MatchEntry,
} from "../lib/core/expenses"
import { extractAccounts, type AccountInput } from "../lib/core/multi-account-extract"
import type { Transaction } from "../lib/core/types"
import type { BankId } from "../lib/core/prompts"

for (const ch of ["log", "warn"] as const) {
  const orig = console[ch].bind(console)
  console[ch] = (...a: unknown[]) => {
    if (String(a[0] ?? "").includes("standardFontDataUrl")) return
    orig(...a)
  }
}

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const tx = (date: string, debit: number, description = ""): Transaction => ({
  date,
  description,
  debit,
  credit: 0,
  balance: null,
})

// --- 1. Synthetic ---------------------------------------------------------
console.log("\n# Synthetic")

const CSV = `"Supplier","Description","Category","Date","Amount","VAT Total"
"Circle K Clontarf","Circle K Clontarf - Diesel, and other","Motor Expenses","2025-12-30","30.03","5.62"
"Woodie's DIY","Woodie's DIY - ""ZINSSER""","Repairs & Maintenance","2025-12-27","55.49","10.38"
"Zero Co","placeholder","Other","2025-12-01","0.00","0.00"`

const parsed = parseExpensesCsv(CSV)
check("parse: 3 expenses", parsed.length === 3)
check("parse: quoted comma kept in description", parsed[0].description.includes("Diesel, and other"))
check("parse: escaped quotes unescaped", parsed[1].description.includes('"ZINSSER"'))
check("parse: amount -> cents", parsed[0].amountCents === 3003 && parsed[1].amountCents === 5549)
check("parse: category + date", parsed[0].category === "Motor Expenses" && parsed[0].date === "2025-12-30")
check("parse: zero amount", parsed[2].amountCents === 0)
check("parse: no link column -> link undefined", parsed[0].link === undefined)

// Optional link column: detected by a header containing "link" or "url" (exact name varies).
{
  const withLink = parseExpensesCsv(
    `"Supplier","Category","Date","Amount","Link"
"A","X","2025-06-01","10.00","https://receipts.example/1"`,
  )
  check("parse: 'Link' header -> link captured", withLink[0].link === "https://receipts.example/1")
  const withUrl = parseExpensesCsv(
    `"Supplier","Category","Date","Amount","Receipt URL"
"B","X","2025-06-02","20.00","https://receipts.example/2"`,
  )
  check("parse: 'Receipt URL' header -> link captured (substring)", withUrl[0].link === "https://receipts.example/2")
}

// Matching: exact cents + supplier name + date window (±5). Both debits carry the name.
{
  const entries: MatchEntry[] = [
    { tx: tx("2025-12-31", 30.03, "POS CIRCLE K CLONTARF") }, // +1 day, name present -> match
    { tx: tx("2025-12-27", 55.49, "WOODIES DIY") }, // exact day, name present -> match
  ]
  const r = matchExpenses(parsed, entries)
  check("match: 2 of 3 found (zero-amount not matchable)", r.foundCount === 2 && r.total === 3)
  check("match: matched rows tagged Expense", entries.every((e) => e.tx.category === "Expense"))
  check("match: zero-amount expense not found", r.matches[2].found === false)
  check("match: records matched date", r.matches[0].matchedDate === "2025-12-31")
}
// Date window edge: +5 matches, +6 doesn't (name present in both).
{
  const ck = parseExpensesCsv(CSV)[0] // Circle K Clontarf, 2025-12-30, 30.03
  const e5 = matchExpenses([ck], [{ tx: tx("2026-01-04", 30.03, "POS CIRCLE K CLONTARF") }]) // +5 days
  const e6 = matchExpenses([ck], [{ tx: tx("2026-01-05", 30.03, "POS CIRCLE K CLONTARF") }]) // +6 days
  check("match: +5 days within window", e5.foundCount === 1)
  check("match: +6 days outside window", e6.foundCount === 0)
}
// One-to-one: two same-amount, same-name expenses, one debit -> one found, one not.
{
  const two = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Tesco","A","X","2025-06-01","10.00"
"Tesco","B","X","2025-06-02","10.00"`,
  )
  const one = matchExpenses(two, [{ tx: tx("2025-06-01", 10.0, "POS TESCO EXPRESS") }])
  check("match: one-to-one (2 expenses, 1 debit -> 1 found)", one.foundCount === 1)
}
// Source: the matched debit's file + page are recorded.
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Woodies","A","X","2025-06-10","20.00"`,
  )
  const r = matchExpenses([exp], [
    { tx: { ...tx("2025-06-10", 20.0, "POS WOODIES CORK"), sourceFile: "june.pdf", page: 3 }, account: "AIB" },
  ])
  check(
    "match: records source file + page",
    r.matches[0].matchedSourceFile === "june.pdf" && r.matches[0].matchedPage === 3,
  )
}
// Export shape: original CSV preserved verbatim (incl. VAT) + exactly 4 appended columns.
{
  const r = matchExpenses(parsed, [{ tx: tx("2025-12-30", 30.03, "POS CIRCLE K CLONTARF") }])
  const csv = expensesReportToCsv(r)
  const head = csv.split("\n")[0]
  check("export: preserves original VAT column", head.includes("VAT Total"))
  check("export: appends Found + separate Matched account/date + Source", head.endsWith("Found,Matched account,Matched date,Source"))
  check("export: preserves a VAT value in a data row", csv.includes(",5.62,") && csv.includes(",10.38,"))
  check("export: found/not found rows", csv.includes(",found,") && csv.includes(",not found,"))
}
// Export: the link column keeps its ORIGINAL name + value (only Found/Matched/Source are added).
{
  const wl = parseExpensesCsv(
    `"Supplier","Amount","Receipt URL"
"A","10.00","https://receipts.example/1"`,
  )
  const csv = expensesReportToCsv(matchExpenses(wl, []))
  const head = csv.split("\n")[0]
  check(
    "export: link column keeps its original name",
    head === "Supplier,Amount,Receipt URL,Found,Matched account,Matched date,Source",
  )
  check("export: original link URL preserved", csv.includes("https://receipts.example/1"))
}

// --- Fuzzy supplier-name matcher + NAME-REQUIRED matching -----------------
console.log("\n# Fuzzy name matcher + name-required matching")
// nameMatches unit checks — truncation, punctuation, and no false hits.
check("name: truncation (Screwfix Blanchardstown -> SCREW)", nameMatches("Screwfix Blanchardstown", "POS SCREW DUBLIN"))
check("name: full brand in the line", nameMatches("Screwfix Blanchardstown", "SCREWFIX IE 12"))
check("name: punctuation B&Q == 'B & Q'", nameMatches("B&Q", "B & Q RETAIL PARK"))
check("name: no false hit ('EE' inside 'coffee')", !nameMatches("EE", "COFFEE ANGEL DUBLIN"))
check("name: generic-only supplier never matches", !nameMatches("Services Ltd", "RANDOM MERCHANT CORK"))
check("name: unrelated brands don't match", !nameMatches("Tesco", "SUPERVALU CORK"))
// Generic-word collisions must NOT match (real false positives found on live data).
check("name: 'Service Station' doesn't collide via 'station'", !nameMatches("Spar Hollystown Service Station", "Circle K Gas Station"))
check("name: 'Ireland' doesn't collide", !nameMatches("Screwfix Ireland Ltd", "LIDL IRELAND"))
check("name: but the real brand still matches", nameMatches("Screwfix Ireland Ltd", "POSC23SEP SCREWFIX IR"))

// Exact amount + name + within window -> found.
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Screwfix Blanchardstown","tools","X","2025-06-10","50.00"`,
  )
  const r = matchExpenses([exp], [{ tx: tx("2025-06-12", 50.0, "POS SCREWFIX IE") }])
  check("match: exact amount + name + <=5d -> found", r.matches[0].found === true && r.matches[0].matchedDescription === "POS SCREWFIX IE")
}
// Exact amount but the NAME is ABSENT -> NOT found (the key precision rule: no
// coincidental same-amount match to a different merchant / a transfer / an ATM).
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Toolfix","tools","X","2025-06-10","50.00"`,
  )
  const r = matchExpenses([exp], [{ tx: tx("2025-06-10", 50.0, "Transfer to JOHN SMITH") }])
  check("match: exact amount but NO name -> not found", r.matches[0].found === false)
}
// Name present but the amount differs -> NOT found (amount must be exact).
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Screwfix","tools","X","2025-06-10","50.00"`,
  )
  const r = matchExpenses([exp], [{ tx: tx("2025-06-11", 52.0, "POS SCREWFIX IE") }])
  check("match: name present but amount differs -> not found", r.matches[0].found === false)
}
// Exact amount + name but OUTSIDE the ±5-day window -> NOT found.
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Woodies","paint","X","2025-06-01","20.00"`,
  )
  const r = matchExpenses([exp], [{ tx: tx("2025-06-20", 20.0, "POS WOODIES CORK") }]) // +19 days
  check("match: exact amount + name but >5 days -> not found", r.matches[0].found === false)
}

// --- 2. Real case (case 2: BOI x3 + Revolut) ------------------------------
const ROOT = join(process.cwd(), "statements", "expenses-reconciliation")
const pdf = (dir: string, name: string) => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) })

async function runCase(n: string, inputs: AccountInput[]) {
  const dir = join(ROOT, n)
  if (!existsSync(join(dir, "expenses.csv"))) {
    console.log(`\n# Case ${n} — skipped (no data)`)
    return
  }
  console.log(`\n# Case ${n}`)
  const { accounts } = await extractAccounts(inputs, { allowAiFallback: false })
  const entries: MatchEntry[] = accounts.flatMap((a) =>
    a.transactions.map((t) => ({ tx: t, account: a.label })),
  )
  const expenses = parseExpensesCsv(readFileSync(join(dir, "expenses.csv"), "utf8"))
  const report = matchExpenses(expenses, entries)
  const debits = entries.filter((e) => e.tx.debit > 0).length
  console.log(`   accounts: ${accounts.map((a) => `${a.label}(${a.transactionCount}tx)`).join(", ")}`)
  console.log(`   debits in statements: ${debits}`)
  console.log(`   expenses: ${report.foundCount}/${report.total} found (${((report.foundCount / report.total) * 100).toFixed(0)}%)`)
  const notFound = report.matches.filter((m) => !m.found && m.expense.amountCents > 0).slice(0, 8)
  if (notFound.length) {
    console.log("   sample not-found:")
    for (const m of notFound) console.log(`     ${m.expense.date}  ${m.expense.amount.toFixed(2)}  ${m.expense.supplier}`)
  }
}

const c2 = join(ROOT, "2")
if (existsSync(c2)) {
  const boiFiles = readdirSync(c2).filter((f) => /^BOI-\d+\.pdf$/i.test(f)).sort()
  await runCase("2", [
    { bank: "boi" as BankId, files: boiFiles.map((f) => pdf(c2, f)) },
    { bank: "revolut" as BankId, files: [pdf(c2, "Revolut - Euro.pdf")] },
  ])
}

console.log(`\n${failures === 0 ? "All synthetic checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
