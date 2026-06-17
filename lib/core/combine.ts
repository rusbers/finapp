/**
 * Combine several parsed statements (multiple PDFs of the same account, e.g. the
 * monthly statements AIB generates automatically) into one chronological series.
 *
 * Statements are chained by balance: the closing balance of one statement equals
 * the opening balance of the next. We:
 *   1. Find the first statement (its opening balance isn't any other's closing).
 *   2. Follow the chain (closing → matching opening) to order them.
 *   3. Flag a GAP whenever a closing balance has no matching opening (a missing
 *      statement in the series).
 *   4. Concatenate transactions in chain order, leaving each statement's internal
 *      order untouched (bank order — important so the running balance stays valid).
 *
 * The result is one StatementData (opening = first statement's opening, closing =
 * last statement's closing) that reconciles across the whole series, plus any
 * gap warnings.
 */

import type { StatementData } from "./types"

const TOLERANCE = 0.02 // cent-level tolerance for matching balances

export interface StatementGap {
  /** The statement after which the chain breaks (its closing has no match). */
  afterClosingBalance: number
  /** The next statement we did find, whose opening doesn't match (if any). */
  nextOpeningBalance: number | null
}

export interface CombineResult {
  combined: StatementData
  /** Statements in the resolved chain order (banks/labels preserved). */
  orderedCount: number
  /** Gaps detected between statements (a missing statement breaks the chain). */
  gaps: StatementGap[]
  /** True if every statement linked into a single clean chain. */
  fullyChained: boolean
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE
}

/**
 * Order statements into a balance-linked chain and merge them.
 * If chaining fails (e.g. balances don't line up at all), falls back to the
 * given order so the user still gets a combined result they can inspect.
 */
export function combineStatements(statements: StatementData[]): CombineResult {
  if (statements.length === 0) {
    return {
      combined: { bank: "", openingBalance: 0, closingBalance: 0, transactions: [] },
      orderedCount: 0,
      gaps: [],
      fullyChained: true,
    }
  }

  if (statements.length === 1) {
    return {
      combined: statements[0],
      orderedCount: 1,
      gaps: [],
      fullyChained: true,
    }
  }

  // Build the chain. Find a head: a statement whose opening balance is not the
  // closing balance of any other statement.
  const isClosingOfAnother = (opening: number, selfIndex: number): boolean =>
    statements.some((s, i) => i !== selfIndex && approxEqual(s.closingBalance, opening))

  const heads = statements
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => !isClosingOfAnother(s.openingBalance, i))

  // Ideal case: exactly one head. If zero or many (ambiguous/cyclic/duplicate),
  // fall back to the input order but still chain-check for gaps.
  const used = new Set<number>()
  const ordered: StatementData[] = []
  let cleanChain = true

  if (heads.length === 1) {
    let currentIndex: number | null = heads[0].i
    while (currentIndex !== null && !used.has(currentIndex)) {
      const current = statements[currentIndex]
      ordered.push(current)
      used.add(currentIndex)
      // Find the next statement whose opening matches this closing.
      const nextIndex = statements.findIndex(
        (s, i) => !used.has(i) && approxEqual(s.openingBalance, current.closingBalance),
      )
      currentIndex = nextIndex === -1 ? null : nextIndex
    }
    // Any statements not reached belong to a broken/separate chain.
    if (used.size !== statements.length) cleanChain = false
  } else {
    cleanChain = false
  }

  // Append any statements not placed by chaining, in their original order, so
  // nothing is silently dropped.
  if (ordered.length !== statements.length) {
    statements.forEach((s, i) => {
      if (!used.has(i)) ordered.push(s)
    })
  }

  // Detect gaps: walk the ordered list; a gap exists wherever a statement's
  // closing balance doesn't equal the next statement's opening balance.
  const gaps: StatementGap[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    if (!approxEqual(ordered[i].closingBalance, ordered[i + 1].openingBalance)) {
      gaps.push({
        afterClosingBalance: ordered[i].closingBalance,
        nextOpeningBalance: ordered[i + 1].openingBalance,
      })
    }
  }

  const combined: StatementData = {
    bank: ordered[0].bank,
    openingBalance: ordered[0].openingBalance,
    closingBalance: ordered[ordered.length - 1].closingBalance,
    transactions: ordered.flatMap((s) => s.transactions),
  }

  return {
    combined,
    orderedCount: ordered.length,
    gaps,
    fullyChained: cleanChain && gaps.length === 0,
  }
}
