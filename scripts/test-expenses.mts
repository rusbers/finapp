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
  supplierMatches,
  EXPENSE_CATEGORY,
  EXPENSE_TBC_CATEGORY,
  isExpenseMarker,
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

// Matching: exact cents + supplier name + date window (±7). Both debits carry the name.
{
  const entries: MatchEntry[] = [
    { tx: tx("2025-12-31", 30.03, "POS CIRCLE K CLONTARF") }, // +1 day, name present -> match
    { tx: tx("2025-12-27", 55.49, "WOODIES DIY") }, // exact day, name present -> match
  ]
  const r = matchExpenses(parsed, entries)
  check("match: 2 of 3 found (zero-amount not matchable)", r.foundCount === 2 && r.total === 3)
  // Compared against the exported constant, not a literal, so the marker and the route's
  // filter (route.ts) can never drift apart again.
  check("match: matched rows tagged with the marker", entries.every((e) => e.tx.category === EXPENSE_CATEGORY))
  check("match: the marker is plural", EXPENSE_CATEGORY === "Expenses")
  // The marker never overwrites a category the row already has (a re-imported CSV/Excel
  // whose categories the user typed): the match is reported, the category stays.
  const kept: MatchEntry[] = [{ tx: { ...tx("2025-12-31", 30.03, "POS CIRCLE K CLONTARF"), category: "Fuel" } }]
  const rk = matchExpenses(parsed, kept)
  check("match: a row with its own category keeps it (not replaced by the marker)", rk.foundCount === 1 && kept[0].tx.category === "Fuel")
  check("match: zero-amount expense not found", r.matches[2].found === false)
  check("match: records matched date", r.matches[0].matchedDate === "2025-12-31")
  check("match: day gap is signed (+1, bank posted after the invoice)", r.matches[0].matchedDayGap === 1)
  check("match: a not-found row has no day gap", r.matches[2].matchedDayGap === undefined)
}
// Date window edge: +7 matches, +8 doesn't (name present in both).
{
  const ck = parseExpensesCsv(CSV)[0] // Circle K Clontarf, 2025-12-30, 30.03
  const e5 = matchExpenses([ck], [{ tx: tx("2026-01-06", 30.03, "POS CIRCLE K CLONTARF") }]) // +7 days
  const e6 = matchExpenses([ck], [{ tx: tx("2026-01-07", 30.03, "POS CIRCLE K CLONTARF") }]) // +8 days
  check("match: +7 days within window", e5.foundCount === 1)
  check("match: +8 days outside window", e6.foundCount === 0)
  check("match: day gap at the window edge is +7", e5.matches[0].matchedDayGap === 7)
}
// Day gap sign + zero. A debit dated BEFORE its invoice yields a NEGATIVE gap — the whole
// point of reporting it signed, since that direction is the one worth a second look.
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Woodies","paint","X","2025-06-12","20.00"`,
  )
  const before = matchExpenses([exp], [{ tx: tx("2025-06-08", 20.0, "POS WOODIES CORK") }]) // -4 days
  check("match: debit before the invoice -> negative day gap", before.matches[0].matchedDayGap === -4)
  const same = matchExpenses([exp], [{ tx: tx("2025-06-12", 20.0, "POS WOODIES CORK") }])
  check("match: same-day match -> day gap 0", same.matches[0].matchedDayGap === 0)
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
// Export shape: original CSV preserved verbatim (incl. VAT) + exactly 8 appended columns.
{
  const r = matchExpenses(parsed, [{ tx: tx("2025-12-30", 30.03, "POS CIRCLE K CLONTARF") }])
  const csv = expensesReportToCsv(r)
  const head = csv.split("\n")[0]
  check("export: preserves original VAT column", head.includes("VAT Total"))
  check(
    "export: appends Found + TBC + TBC reason + Matched account/date/description + Days + Source",
    head.endsWith("Found,TBC,TBC reason,Matched account,Matched date,Matched description,Days,Source"),
  )
  check("export: a certain match has TBC FALSE, not-found has it empty", csv.includes(",found,FALSE,,") && csv.includes(",not found,,,"))
  check("export: preserves a VAT value in a data row", csv.includes(",5.62,") && csv.includes(",10.38,"))
  check("export: found/not found rows", csv.includes(",found,") && csv.includes(",not found,"))
  check("export: carries the matched bank description", csv.includes("POS CIRCLE K CLONTARF"))
  // A PLAIN signed integer (no "+" prefix) so a spreadsheet reads the cell as a number —
  // the "+1" form is UI-only. This match is same-day, so the cell is "0".
  check("export: Days is a plain number", csv.includes("POS CIRCLE K CLONTARF,0,"))
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
    head ===
      "Supplier,Amount,Receipt URL,Found,TBC,TBC reason,Matched account,Matched date,Matched description,Days,Source",
  )
  check("export: original link URL preserved", csv.includes("https://receipts.example/1"))
}
// TBC ("to be confirmed"): a found match outside the normal 0–3 day lag, or picked from
// several equally valid debits, is flagged with a plain-words reason.
{
  const [w] = parseExpensesCsv(`"Supplier","Category","Date","Amount"\n"Woodies","X","2025-06-10","20.00"`)
  const at = (date: string, ...more: string[]) =>
    matchExpenses([w], [date, ...more].map((d) => ({ tx: tx(d, 20, "POS WOODIES CORK") })))
  const ok = at("2025-06-11") // +1
  check("tbc: +1 day is certain", ok.matches[0].tbc === false && ok.tbcCount === 0)
  const edge = at("2025-06-13") // +3
  check("tbc: +3 days (edge of normal lag) is certain", edge.matches[0].tbc === false)
  const late = at("2025-06-15") // +5
  check("tbc: +5 days flagged", late.matches[0].tbc === true && late.tbcCount === 1)
  check("tbc: +5 reason", late.matches[0].tbcReasons?.[0] === "bank posted 5 days after the receipt")
  const early = at("2025-06-04") // -6
  check("tbc: bank before receipt flagged", early.matches[0].tbcReasons?.[0] === "bank posted 6 days before the receipt")
  const one = at("2025-06-09") // -1
  check("tbc: singular day", one.matches[0].tbcReasons?.[0] === "bank posted 1 day before the receipt")
  const two = at("2025-06-11", "2025-06-12") // two valid debits
  check("tbc: several possible debits flagged", two.matches[0].tbc === true && two.matches[0].tbcReasons?.[0] === "2 possible debits — closest date picked")
  check("tbc: closest still picked", two.matches[0].matchedDate === "2025-06-11")
  const none = matchExpenses([w], [])
  check("tbc: not-found has no tbc", none.matches[0].tbc === undefined && none.tbcCount === 0)
  const csv = expensesReportToCsv(late)
  check("tbc: export carries TRUE + reason", csv.includes(",found,TRUE,bank posted 5 days after the receipt,"))
  // The matched debit's category marker tells the two apart in the transaction table.
  const lateEntry: MatchEntry[] = [{ tx: tx("2025-06-15", 20, "POS WOODIES CORK") }]
  matchExpenses([w], lateEntry)
  check("tbc: a TBC match tags the debit 'Expenses TBC'", lateEntry[0].tx.category === EXPENSE_TBC_CATEGORY && EXPENSE_TBC_CATEGORY === "Expenses TBC")
  const okEntry: MatchEntry[] = [{ tx: tx("2025-06-11", 20, "POS WOODIES CORK") }]
  matchExpenses([w], okEntry)
  check("tbc: a certain match tags the debit 'Expenses'", okEntry[0].tx.category === EXPENSE_CATEGORY)
  const keptEntry: MatchEntry[] = [{ tx: { ...tx("2025-06-15", 20, "POS WOODIES CORK"), category: "DIY" } }]
  matchExpenses([w], keptEntry)
  check("tbc: a row with its own category keeps it", keptEntry[0].tx.category === "DIY")
  check("marker: both markers recognised, others not", isExpenseMarker("Expenses") && isExpenseMarker("Expenses TBC") && !isExpenseMarker("Fuel") && !isExpenseMarker(undefined))
}

// --- Fuzzy supplier-name matcher + NAME-REQUIRED matching -----------------
console.log("\n# Fuzzy name matcher + name-required matching")
// nameMatches unit checks — truncation, punctuation, and no false hits.
check("name: truncation (Screwfix Blanchardstown -> SCREW)", nameMatches("Screwfix Blanchardstown", "POS SCREW DUBLIN"))
check("name: full brand in the line", nameMatches("Screwfix Blanchardstown", "SCREWFIX IE 12"))
check("name: punctuation B&Q == 'B & Q'", nameMatches("B&Q", "B & Q RETAIL PARK"))
check("name: B&Q == AIB 'VDC-B & Q IRELAND'", nameMatches("B&Q", "VDC-B & Q IRELAND"))
check("name: 'B&Q Ireland' == 'B & Q' (generic word dropped)", nameMatches("B&Q Ireland", "VDC-B & Q TALLAGHT"))
check("name: 'PTRS Limited' == spaced 'P T R S'", nameMatches("PTRS Limited", "VDP-P T R S"))
// Supplier aliases (supplier-aliases.ts): a name the bank shows differently entirely.
check("alias: CSS LTD == VDP-CITYSAWSERVICE", supplierMatches("CSS LTD", "VDP-CITYSAWSERVICE"))
check("alias: Applus Inspection Services == WWW NCTS IE", supplierMatches("Applus Inspection Services Ireland Ltd (NCT)", "VDP-WWW NCTS IE FO"))
check("alias: AIC PAINTS needs the whole phrase (not just 'paints')", !supplierMatches("Allied Industrial Coatings Ltd", "VDC-PAT MCDONNELL PAINTS"))
check("alias: unrelated supplier gets no alias", !supplierMatches("Woodies", "VDP-CITYSAWSERVICE"))
check("alias: off when an empty list is passed", !supplierMatches("CSS LTD", "VDP-CITYSAWSERVICE", []))
{
  const [css] = parseExpensesCsv(`"Supplier","Category","Date","Amount"\n"CSS LTD","X","2025-12-02","900.66"`)
  const hit = matchExpenses([css], [{ tx: tx("2025-12-02", 900.66, "VDP-CITYSAWSERVICE") }])
  const wrongAmount = matchExpenses([css], [{ tx: tx("2025-12-02", 900.65, "VDP-CITYSAWSERVICE") }])
  const tooLate = matchExpenses([css], [{ tx: tx("2025-12-10", 900.66, "VDP-CITYSAWSERVICE") }]) // +8 days
  check("alias match: same amount, same day -> found", hit.foundCount === 1)
  check("alias match: amount still must be exact", wrongAmount.foundCount === 0)
  check("alias match: date window still applies", tooLate.foundCount === 0)
}
// Late-paying suppliers (supplier-payment-terms.ts): eFlow is charged ~16 days after the
// invoice. Only the AFTER side widens (amounts repeat monthly), and every such match is TBC.
{
  const eflow = (date: string, amount = "16.53") =>
    parseExpensesCsv(`"Supplier","Category","Date","Amount"\n"eFlow","Tolls","${date}","${amount}"`)[0]
  const debit = (date: string, amount = 16.53) => ({ tx: tx(date, amount, "VDP-EFLOW BARRIER") })
  const late: MatchEntry[] = [debit("2025-06-17")] // +16
  const r16 = matchExpenses([eflow("2025-06-01")], late)
  check("late payer: eFlow +16 days found", r16.foundCount === 1 && r16.matches[0].matchedDayGap === 16)
  check(
    "late payer: +16 is TBC with the late-payment reason",
    r16.matches[0].tbc === true && r16.matches[0].tbcReasons?.[0] === "bank posted 16 days after the receipt (late-payment supplier)",
  )
  check("late payer: debit tagged 'Expenses TBC'", late[0].tx.category === EXPENSE_TBC_CATEGORY)
  const r2 = matchExpenses([eflow("2025-06-01")], [debit("2025-06-03")]) // +2
  check("late payer: +2 days found and certain", r2.foundCount === 1 && r2.matches[0].tbc === false)
  check("late payer: +26 days not found", matchExpenses([eflow("2025-06-01")], [debit("2025-06-27")]).foundCount === 0)
  check("late payer: -10 days (previous month) not found", matchExpenses([eflow("2025-06-01")], [debit("2025-05-22")]).foundCount === 0)
  // Two monthly charges of the same amount: each invoice gets its OWN month's charge.
  const months = matchExpenses([eflow("2025-07-01"), eflow("2025-06-01")], [debit("2025-06-17"), debit("2025-07-17")])
  check(
    "late payer: recurring amount → each invoice gets its own month",
    months.matches[0].matchedDate === "2025-07-17" && months.matches[1].matchedDate === "2025-06-17",
  )
  check(
    "late payer: a non-listed supplier at +16 is still not found",
    matchExpenses(
      parseExpensesCsv(`"Supplier","Category","Date","Amount"\n"Woodies","X","2025-06-01","20.00"`),
      [{ tx: tx("2025-06-17", 20, "POS WOODIES CORK") }],
    ).foundCount === 0,
  )
  check("late payer: an empty list restores the ±7 window", matchExpenses([eflow("2025-06-01")], [debit("2025-06-17")], { paymentTerms: [] }).foundCount === 0)
}
// Real case: B&Q receipt dated 6 days after the bank posting — inside the ±7 window.
{
  const [bq] = parseExpensesCsv(`"Supplier","Category","Date","Amount"\n"B&Q","X","2025-11-10","54.00"`)
  const r = matchExpenses([bq], [{ tx: tx("2025-11-04", 54, "VDC-B & Q IRELAND") }])
  check("match: B&Q -6 days found", r.foundCount === 1 && r.matches[0].matchedDayGap === -6)
}
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
// Exact amount + name but OUTSIDE the ±7-day window -> NOT found.
{
  const [exp] = parseExpensesCsv(
    `"Supplier","Description","Category","Date","Amount"
"Woodies","paint","X","2025-06-01","20.00"`,
  )
  const r = matchExpenses([exp], [{ tx: tx("2025-06-20", 20.0, "POS WOODIES CORK") }]) // +19 days
  check("match: exact amount + name but >7 days -> not found", r.matches[0].found === false)
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
