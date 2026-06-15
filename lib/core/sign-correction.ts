/**
 * Balance-based debit/credit correction.
 *
 * Models sometimes put a transaction's amount in the wrong column (a debit shown
 * as a credit, or vice versa). When the statement provides a running balance, we
 * can tell the true direction from the math:
 *   - balance went DOWN  → money out → debit
 *   - balance went UP    → money in  → credit
 *
 * We only correct when we're certain: both this row and the previous one have a
 * balance, AND the size of the balance change matches the transaction amount
 * (within tolerance). Otherwise we leave the row untouched. This never invents
 * data — it only flips a sign the balance unambiguously contradicts.
 */

import type { StatementData, SignCorrection } from "./types"
import { toCents } from "./reconciliation"

const TOLERANCE_CENTS = 2

/**
 * Returns a corrected copy of the statement plus a list of the corrections made.
 * The opening balance anchors the first comparison.
 */
export function correctSignsFromBalance(data: StatementData): {
  data: StatementData
  corrections: SignCorrection[]
} {
  const txs = data.transactions ?? []
  const corrections: SignCorrection[] = []

  // Running "previous balance", starting from the opening balance.
  let prevBalanceCents: number | null =
    data.openingBalance != null ? toCents(data.openingBalance) : null

  const correctedTxs = txs.map((t, index) => {
    const thisBalanceCents = t.balance != null ? toCents(t.balance) : null

    // Need both balances to judge direction.
    if (prevBalanceCents == null || thisBalanceCents == null) {
      // Can't verify — carry this balance forward (if present) and move on.
      if (thisBalanceCents != null) prevBalanceCents = thisBalanceCents
      return t
    }

    const deltaCents = thisBalanceCents - prevBalanceCents // + = up (credit), - = down (debit)
    const amountCents = toCents(t.debit || 0) + toCents(t.credit || 0) // the magnitude the model has

    // Only act if the size of the balance move matches the transaction amount.
    // (If they don't match, something else is off — don't guess.)
    const matchesMagnitude = Math.abs(Math.abs(deltaCents) - amountCents) <= TOLERANCE_CENTS

    let corrected = t
    if (matchesMagnitude && amountCents > 0) {
      const shouldBeCredit = deltaCents > 0
      const shouldBeDebit = deltaCents < 0
      const amount = amountCents / 100

      const modelHasCredit = (t.credit || 0) > 0
      const modelHasDebit = (t.debit || 0) > 0

      if (shouldBeDebit && modelHasCredit) {
        // Model said credit, balance says debit → flip to debit.
        corrected = { ...t, debit: amount, credit: 0 }
        corrections.push({
          index,
          date: t.date,
          description: t.description,
          amount,
          from: "credit",
          to: "debit",
        })
      } else if (shouldBeCredit && modelHasDebit) {
        // Model said debit, balance says credit → flip to credit.
        corrected = { ...t, debit: 0, credit: amount }
        corrections.push({
          index,
          date: t.date,
          description: t.description,
          amount,
          from: "debit",
          to: "credit",
        })
      }
    }

    // Advance using the statement's actual balance (so a single oddity doesn't
    // cascade into every following row).
    prevBalanceCents = thisBalanceCents
    return corrected
  })

  return {
    data: { ...data, transactions: correctedTxs },
    corrections,
  }
}
