/**
 * Headless test for multi-account reconciliation (the "add another bank account" flow).
 *
 * Two parts:
 *   1. SYNTHETIC asserts for the pure helpers (`dedupeLabels`, `mergeAccounts`) — fast,
 *      deterministic, no PDFs.
 *   2. REAL clients under `statements/interbank/<n>/` — EACH NUMBERED FOLDER IS ONE
 *      SEPARATE CLIENT (never mix folders). Runs `extractAccounts` with
 *      allowAiFallback:false (deterministic, no API calls) and prints each account's
 *      reconciliation for inspection, asserting the labels dedupe and the merge is sane.
 *
 * Data lives OUTSIDE git (statements/ is gitignored). Missing folders are skipped with
 * a note, so the script still passes on a machine without the sample data.
 *
 * Usage: npm run test:multi
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { dedupeLabels, mergeAccounts } from "../lib/core/multi-account"
import { extractAccounts, type AccountInput } from "../lib/core/multi-account-extract"
import { combineStatements } from "../lib/core/combine"
import type { Transaction, StatementData } from "../lib/core/types"

// Silence pdfjs's harmless per-font warning (we only read text positions).
for (const ch of ["log", "warn"] as const) {
  const orig = console[ch].bind(console)
  console[ch] = (...a: unknown[]) => {
    if (String(a[0] ?? "").includes("standardFontDataUrl")) return
    orig(...a)
  }
}

let failures = 0
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// --- 1. Synthetic: pure helpers -------------------------------------------

console.log("\n# Synthetic")

// dedupeLabels: first stays, duplicates get numbered; a manual "(2)" is skipped over.
check("dedupe: distinct kept", eq(dedupeLabels(["AIB", "BOI", "Revolut"]), ["AIB", "BOI", "Revolut"]))
check("dedupe: duplicates numbered", eq(dedupeLabels(["AIB", "AIB", "AIB"]), ["AIB", "AIB (2)", "AIB (3)"]))
check("dedupe: trims whitespace", eq(dedupeLabels([" BOI ", "BOI"]), ["BOI", "BOI (2)"]))
check(
  "dedupe: bumps past a manual (2)",
  eq(dedupeLabels(["BOI", "BOI (2)", "BOI"]), ["BOI", "BOI (2)", "BOI (3)"]),
)

// mergeAccounts: chronological, ties broken by account order then row order; every
// row copied with accountLabel; originals untouched.
const tx = (date: string, description: string): Transaction => ({
  date,
  description,
  debit: 0,
  credit: 0,
  balance: null,
})
const accA = { label: "A", transactions: [tx("2024-01-01", "a1"), tx("2024-01-03", "a2")] }
const accB = { label: "B", transactions: [tx("2024-01-02", "b1"), tx("2024-01-03", "b2")] }
const merged = mergeAccounts([accA, accB]).transactions
check(
  "merge: chronological, ties by account then row (a1,b1,a2,b2)",
  eq(merged.map((t) => t.description), ["a1", "b1", "a2", "b2"]),
)
check(
  "merge: each row stamped with its accountLabel",
  eq(merged.map((t) => t.accountLabel), ["A", "B", "A", "B"]),
)
check("merge: originals not mutated", accA.transactions[0].accountLabel === undefined)
check(
  "merge: undated rows sort first",
  mergeAccounts([{ label: "A", transactions: [tx("2024-05-01", "later"), { ...tx("", "undated"), date: "" }] }])
    .transactions[0].description === "undated",
)

// combineStatements: gap detection on BALANCE and DATE. The date check catches a missing
// statement that nets to ZERO (opening == closing), which the balance chain can't see.
const stmt = (opening: number, closing: number, dates: string[]): StatementData => ({
  bank: "aib",
  openingBalance: opening,
  closingBalance: closing,
  transactions: dates.map((d, i) => ({ date: d, description: `t${i}`, debit: 0, credit: 0, balance: null })),
})
// Three consecutive quarterly statements, each opening AND closing at 0.
const q1 = stmt(0, 0, ["2024-01-05", "2024-03-28"])
const q2 = stmt(0, 0, ["2024-04-02", "2024-06-28"])
const q3 = stmt(0, 0, ["2024-07-03", "2024-09-27"])
{
  const all = combineStatements([q1, q2, q3])
  check("combine: 3 contiguous 0→0 statements → no gap", all.gaps.length === 0 && all.fullyChained)
  const missingMiddle = combineStatements([q1, q3]) // q2 (0→0) absent
  check(
    "combine: missing middle 0→0 statement → date gap (invisible to balance)",
    missingMiddle.gaps.length === 1 && !missingMiddle.fullyChained,
  )
}
{
  // Balance break still detected (regression on the balance path).
  const s1 = stmt(0, 50, ["2024-01-05", "2024-01-28"])
  const s2 = stmt(0, 0, ["2024-02-02", "2024-02-28"])
  check("combine: balance mismatch (50 ≠ 0) → gap", combineStatements([s1, s2]).gaps.length === 1)
}
{
  // Two consecutive 0→0 statements with a normal few-day seam → no false date gap.
  const s1 = stmt(0, 0, ["2024-01-05", "2024-01-28"])
  const s2 = stmt(0, 0, ["2024-02-02", "2024-02-28"])
  check("combine: consecutive 0→0 (small seam) → no false gap", combineStatements([s1, s2]).gaps.length === 0)
}
{
  // Dormant start (reproduces AIB 662): a statement OPENS at 22 Aug (BALANCE FORWARD)
  // but its first posting is 2 Dec, preceded by a statement ending 8 Aug. The seam uses
  // the declared OPENING date (14 days), not the first transaction (116 days) → NO false
  // gap. Without openingDate the old code would have flagged a spurious gap here.
  const prev = stmt(0, 0, ["2024-05-24", "2024-08-08"])
  const dormant: StatementData = { ...stmt(0, 0, ["2024-12-02", "2025-02-21"]), openingDate: "2024-08-22" }
  check(
    "combine: dormant-start statement (opening date used) → no false gap",
    combineStatements([prev, dormant]).gaps.length === 0,
  )
}

// --- 2. Real clients -------------------------------------------------------

const ROOT = join(process.cwd(), "statements", "interbank")

/** PDF byte-files directly under `dir` (non-recursive), optionally excluding names. */
function pdfsIn(dir: string, exclude?: RegExp): { name: string; bytes: Uint8Array }[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf") && !(exclude && exclude.test(f)))
    .sort()
    .map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) }))
}

async function runClient(name: string, inputs: AccountInput[], expectedLabels: string[]): Promise<void> {
  console.log(`\n# ${name}`)
  const { accounts, allReconciled } = await extractAccounts(inputs, { allowAiFallback: false })
  for (const a of accounts) {
    const status = a.transactionCount === 0 ? "— (empty)" : a.reconciliation.passed ? "reconciled" : `OFF BY ${a.reconciliation.discrepancyCents}c`
    const extra = a.gaps && a.gaps.length ? `, gaps:${a.gaps.length}` : ""
    console.log(`   ${a.label}: ${a.transactionCount} tx, ${a.fileNames.length} file(s), ${status}${extra}`)
  }
  check(`${name}: labels deduped as expected`, eq(accounts.map((a) => a.label), expectedLabels))
  check(`${name}: every account has transactions`, accounts.every((a) => a.transactionCount > 0))

  // The combined table's merge must be chronologically non-decreasing and fully stamped.
  const combined = mergeAccounts(accounts.map((a) => ({ label: a.label, transactions: a.transactions }))).transactions
  const sorted = combined.every((t, i) => i === 0 || (combined[i - 1].date ?? "") <= (t.date ?? ""))
  check(`${name}: combined rows are chronological`, sorted)
  check(`${name}: combined rows all carry accountLabel`, combined.every((t) => !!t.accountLabel))
  console.log(`   → combined: ${combined.length} rows, allReconciled=${allReconciled}`)
}

// Client 1: four AIB accounts (each several PDFs) + one Revolut. Empty labels →
// short bank names, deduped to AIB / AIB (2) / AIB (3) / AIB (4) / Revolut.
const c1 = join(ROOT, "1")
if (existsSync(c1)) {
  await runClient(
    "Client 1 (4× AIB + Revolut)",
    [
      { bank: "aib", files: pdfsIn(join(c1, "AIB 589")) },
      { bank: "aib", files: pdfsIn(join(c1, "AIB 662")) },
      { bank: "aib", files: pdfsIn(join(c1, "AIB BUS")) },
      { bank: "aib", files: pdfsIn(join(c1, "AIB Pers"), /combined/i) }, // drop the overlapping combined PDF
      { bank: "revolut", files: pdfsIn(c1, /combined/i) }, // Revolut - spouse.pdf sits at the folder root
    ],
    ["AIB", "AIB (2)", "AIB (3)", "AIB (4)", "Revolut"],
  )
} else {
  console.log("\n# Client 1 — skipped (statements/interbank/1 not present)")
}

// Client 3: BOI (several PDFs) + Revolut with a MANUAL label. Different banks; the
// manual label wins over the short default.
const c3 = join(ROOT, "3")
if (existsSync(c3)) {
  await runClient(
    "Client 3 (BOI + Revolut, manual label)",
    [
      { bank: "boi", files: pdfsIn(join(c3, "Boi")) },
      { bank: "revolut", label: "Personal Revolut", files: pdfsIn(c3) }, // revolut 2024.pdf at the root
    ],
    ["BOI", "Personal Revolut"],
  )
} else {
  console.log("\n# Client 3 — skipped (statements/interbank/3 not present)")
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
