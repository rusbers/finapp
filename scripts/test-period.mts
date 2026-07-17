/**
 * Headless test for Financial-period slicing (lib/core/period.ts) — pure asserts.
 *   1. slicePeriod on a single statement: year / range / empty / all, deriving the
 *      period's opening (from the running balance) + closing, and reconciling to the cent.
 *   2. The multi-account logic the UI runs: slice EACH account to the period, re-reconcile
 *      it, and aggregate `allReconciled` — so a year-cut works across several accounts.
 *
 * Usage: npm run test:period
 */

import { slicePeriod, type Period } from "../lib/core/period"
import { checkReconciliation } from "../lib/core/reconciliation"
import type { StatementData, Transaction } from "../lib/core/types"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}
const tx = (date: string, debit: number, credit: number, balance: number): Transaction => ({
  date,
  description: `${date} d${debit} c${credit}`,
  debit,
  credit,
  balance,
})

// A clean statement (opening 100 → closing 300) spanning 2023 → 2024, running balance printed.
const acc: StatementData = {
  bank: "BOI",
  openingBalance: 100,
  closingBalance: 300,
  transactions: [
    tx("2023-12-01", 0, 50, 150),
    tx("2023-12-15", 30, 0, 120),
    tx("2024-01-10", 0, 200, 320),
    tx("2024-06-20", 100, 0, 220),
    tx("2024-12-31", 0, 80, 300),
  ],
}
const passes = (d: StatementData) => checkReconciliation(d).passed

console.log("# slicePeriod — single statement")
check("full statement reconciles", passes(acc))
check("period 'all' returns the data unchanged", slicePeriod(acc, { kind: "all" }) === acc)

const y2024 = slicePeriod(acc, { kind: "year", year: "2024" })
check("2024: 3 rows", y2024.transactions.length === 3)
check("2024: opening = prev row's balance (120)", y2024.openingBalance === 120)
check("2024: closing = last row's balance (300)", y2024.closingBalance === 300)
check("2024: reconciles to the cent", passes(y2024))

const y2023 = slicePeriod(acc, { kind: "year", year: "2023" })
check("2023: opening = statement opening (100)", y2023.openingBalance === 100)
check("2023: closing 120, reconciles", y2023.closingBalance === 120 && passes(y2023))

const y2025 = slicePeriod(acc, { kind: "year", year: "2025" })
check("2025 (no rows): empty + opening=closing=0 + reconciles", y2025.transactions.length === 0 && y2025.openingBalance === 0 && y2025.closingBalance === 0 && passes(y2025))

const range = slicePeriod(acc, { kind: "range", from: "2024-06-01", to: "2024-12-31" })
check("range 2024-06..12: 2 rows, opening 320, closing 300, reconciles", range.transactions.length === 2 && range.openingBalance === 320 && range.closingBalance === 300 && passes(range))

// --- Multi-account: the exact logic app/page.tsx runs to build `displayMulti`. ---
console.log("\n# Multi-account per-account slice + aggregate")
const accB: StatementData = {
  bank: "AIB",
  openingBalance: 0,
  closingBalance: 40,
  transactions: [
    tx("2024-03-01", 0, 100, 100),
    tx("2024-09-01", 60, 0, 40),
  ],
}
const accC: StatementData = {
  // No 2024 rows — a dormant account for that year.
  bank: "Revolut",
  openingBalance: 10,
  closingBalance: 10,
  transactions: [tx("2023-05-01", 0, 0, 10)],
}

const sliceMulti = (accounts: StatementData[], period: Period) => {
  const sliced = accounts.map((a) => {
    const s = slicePeriod(a, period)
    return { transactionCount: s.transactions.length, reconciliation: checkReconciliation(s) }
  })
  return { sliced, allReconciled: sliced.every((a) => a.transactionCount === 0 || a.reconciliation.passed) }
}

const m2024 = sliceMulti([acc, accB, accC], { kind: "year", year: "2024" })
check("2024 across accounts: acc(3) + accB(2) + accC(0 dormant)", m2024.sliced.map((s) => s.transactionCount).join(",") === "3,2,0")
check("2024 across accounts: all reconcile (dormant account is trivially ok)", m2024.allReconciled === true)

// A broken account should flip allReconciled to false.
const brokenB: StatementData = { ...accB, transactions: [tx("2024-03-01", 0, 100, 100), tx("2024-09-01", 999, 0, 40)] }
const mBroken = sliceMulti([acc, brokenB], { kind: "year", year: "2024" })
check("a mis-balanced account fails the aggregate", mBroken.allReconciled === false)

console.log(`\n${failures === 0 ? "All period checks passed." : `${failures} check(s) FAILED.`}`)
process.exit(failures === 0 ? 0 : 1)
