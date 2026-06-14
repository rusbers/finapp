/**
 * Reconciliation logic — pure, no dependencies beyond shared types.
 * Easy to test and reuse (web, future API, mobile).
 *
 * IMPORTANT: we work in INTEGER CENTS, not floating-point decimals, to avoid
 * floating-point errors (e.g. 0.1 + 0.2) that would cause false reconciliation
 * failures.
 */

import type { StatementData, ReconciliationResult } from "./types";

/** Convert an amount (e.g. 1234.56) into integer cents (123456). */
export function toCents(value: number | string | null | undefined): number {
  const n = Number(value)
  if (Number.isNaN(n)) return 0
  return Math.round(n * 100)
}

/** Format integer cents as a monetary string (123456 -> "1234.56"). */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * Check: openingBalance + sum(credits) - sum(debits) == closingBalance
 * Everything in integer cents, with a small tolerance for rounding.
 */
export function checkReconciliation(data: StatementData, toleranceCents = 2): ReconciliationResult {
  const openingBalanceCents = toCents(data.openingBalance ?? 0)
  const closingBalanceCents = toCents(data.closingBalance ?? 0)
  const transactions = data.transactions ?? []

  const totalCreditCents = transactions.reduce((s, t) => s + toCents(t.credit ?? 0), 0)
  const totalDebitCents = transactions.reduce((s, t) => s + toCents(t.debit ?? 0), 0)

  const computedBalanceCents = openingBalanceCents + totalCreditCents - totalDebitCents
  const discrepancyCents = computedBalanceCents - closingBalanceCents

  return {
    passed: Math.abs(discrepancyCents) <= toleranceCents,
    discrepancyCents,
    totalCreditCents,
    totalDebitCents,
    openingBalanceCents,
    closingBalanceCents,
    computedBalanceCents,
  }
}
