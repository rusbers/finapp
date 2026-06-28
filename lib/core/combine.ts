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
  /** Last transaction date of the statement before the gap (ISO), if known. */
  beforeEnd: string | null
  /** First transaction date of the statement after the gap (ISO), if known —
   * together with `beforeEnd` this is the period the missing statement covers. */
  afterStart: string | null
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

  // Group statements into balance-linked SEGMENTS. A missing statement splits the
  // series into more than one segment; each segment is internally chained
  // (closing → opening). We then order the segments chronologically and report a
  // gap between each consecutive pair — one gap per real break, never a spurious
  // input-order/"wrap" one.
  const isClosingOfAnother = (opening: number, selfIndex: number): boolean =>
    statements.some((s, i) => i !== selfIndex && approxEqual(s.closingBalance, opening))

  const used = new Set<number>()
  const segments: StatementData[][] = []
  const nextInChain = (closing: number): number =>
    statements.findIndex((s, i) => !used.has(i) && approxEqual(s.openingBalance, closing))

  // Start a chain from each head (an opening that isn't any other's closing), then
  // from any still-unused statement (covers cycles / ambiguous balances) — so every
  // statement lands in exactly one segment and nothing is dropped.
  const startOrder = [
    ...statements.map((_, i) => i).filter((i) => !isClosingOfAnother(statements[i].openingBalance, i)),
    ...statements.map((_, i) => i),
  ]
  for (const start of startOrder) {
    if (used.has(start)) continue
    const seg: StatementData[] = []
    let cur: number | null = start
    while (cur !== null && !used.has(cur)) {
      used.add(cur)
      seg.push(statements[cur])
      const nx = nextInChain(statements[cur].closingBalance)
      cur = nx === -1 ? null : nx
    }
    if (seg.length) segments.push(seg)
  }

  // Each segment's covered period = min/max of its transaction dates (ISO → sortable).
  const segPeriod = (seg: StatementData[]): { start: string; end: string } | null => {
    const dates = seg
      .flatMap((s) => s.transactions.map((t) => t.date))
      .filter((d): d is string => !!d)
      .sort()
    return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null
  }

  // Order segments chronologically (undated segments kept last, stable).
  segments.sort((a, b) => {
    const sa = segPeriod(a)?.start ?? null
    const sb = segPeriod(b)?.start ?? null
    if (sa && sb) return sa < sb ? -1 : sa > sb ? 1 : 0
    if (sa) return -1
    if (sb) return 1
    return 0
  })

  const ordered: StatementData[] = segments.flat()

  // One gap per consecutive segment pair = one real missing statement, with the
  // bracketing dates so the UI can name the missing period.
  const gaps: StatementGap[] = []
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i]
    const b = segments[i + 1]
    gaps.push({
      afterClosingBalance: a[a.length - 1].closingBalance,
      nextOpeningBalance: b[0].openingBalance,
      beforeEnd: segPeriod(a)?.end ?? null,
      afterStart: segPeriod(b)?.start ?? null,
    })
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
    fullyChained: segments.length === 1,
  }
}
