/**
 * Combine several parsed statements (multiple PDFs of the same account, e.g. the
 * monthly statements AIB generates automatically) into one chronological series.
 *
 * ORDERING: statements are ordered CHRONOLOGICALLY by their transaction date range,
 * NOT by the balance chain. Some banks print the balance only sporadically (AIB shows
 * it at block checkpoints, so many rows carry 0), which makes closing→opening linking
 * mis-order the statements. Sorting by date is reliable and gives a chronological
 * result. We sort whole statements, leaving each statement's internal row order
 * untouched — important so the running balance stays valid (we never sort individual
 * rows by date).
 *
 * GAP DETECTION runs on that chronological order. A statement is missing between two
 * consecutive statements when EITHER their balances don't carry over (this closing ≠
 * next opening) OR there's a large DATE jump between them (≈ a whole period is missing).
 * The date check catches a missing statement that nets to ZERO — invisible to the
 * balance chain (three statements each opening AND closing at 0, middle one absent,
 * still chain 0→0 and reconcile). We do NOT re-derive the order from the balances —
 * that once split a cleanly-chaining account into a false gap because the value 0
 * appeared as both an opening (a genuine start) and a closing (the account hitting zero).
 *
 * The result is one StatementData (opening = first statement's opening, closing =
 * last statement's closing, both by date order) that reconciles across the whole
 * series, plus any gap warnings.
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

/** Whole days from ISO date `a` to ISO date `b` (b − a). */
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000
}

/** A date jump between two consecutive statements this many days or more (and above
 * half the account's typical statement span) means a whole statement is likely missing
 * — the normal seam between consecutive statements is only a few days. */
const GAP_MIN_DAYS = 25

/**
 * Order statements chronologically (by transaction date range) and merge them into one
 * series, flagging any balance gap between consecutive statements.
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

  // Order the STATEMENTS chronologically by their transaction date range (start, then
  // end). We do NOT chain by balance to establish the order: some banks print the
  // balance only sporadically (AIB shows it at block checkpoints, so many rows carry 0)
  // and a balance can legitimately REPEAT — an account both OPENS at 0 (a genuine
  // start) and later CLOSES at 0 — so closing→opening linking mis-orders the statements
  // (it once linked October's closing 0 to January's opening 0, a whole quarter out of
  // place, and split the series into a false gap). Date order is reliable. We sort
  // whole statements, NOT individual rows — each statement's internal order (and its
  // running balance) stays intact. Undated statements (a no-activity month) keep their
  // input order at the end (Array.sort is stable in V8).
  // A statement's covered period: START is its DECLARED opening date (the BALANCE
  // FORWARD row, set by the parser) when available — this is the true period start and
  // can PRECEDE the first transaction (a statement may open then stay dormant for weeks,
  // e.g. AIB 662's Feb statement opens 22 Aug but its first posting is 2 Dec). We fall
  // back to the first transaction date when no opening date was captured. END is the
  // last transaction date.
  const period = (s: StatementData): { start: string; end: string } | null => {
    const dates = s.transactions
      .map((t) => t.date)
      .filter((d): d is string => !!d)
      .sort()
    const start = s.openingDate || dates[0]
    const end = dates[dates.length - 1] || s.openingDate
    return start && end ? { start, end } : null
  }
  const ordered: StatementData[] = [...statements].sort((a, b) => {
    const pa = period(a)
    const pb = period(b)
    if (pa && pb) {
      if (pa.start !== pb.start) return pa.start < pb.start ? -1 : 1
      if (pa.end !== pb.end) return pa.end < pb.end ? -1 : 1
      return 0
    }
    if (pa) return -1
    if (pb) return 1
    return 0
  })

  // Detect GAPS on the CHRONOLOGICAL order. A statement is likely missing between two
  // consecutive statements when EITHER:
  //   - BALANCE break: this statement's closing ≠ the next's opening (the money doesn't
  //     carry over), OR
  //   - DATE break: the jump from this statement's last transaction to the next's first
  //     is far larger than the normal seam between consecutive statements (≈ a whole
  //     period is missing). This catches a missing statement that nets to ZERO (opening
  //     == closing), invisible to the balance chain — e.g. three statements that each
  //     open AND close at 0 with the middle one absent still chain 0→0 and reconcile.
  // Multi-PDF upload is a CONTINUOUS range of consecutive statements, so the normal seam
  // is only a few days; the DATE threshold adapts to the account's own statement span
  // (half the median span, floored) so a missing period stands out but the seam doesn't.
  const spans = ordered
    .map((s) => {
      const p = period(s)
      return p ? daysBetween(p.start, p.end) : null
    })
    .filter((d): d is number => d != null)
    .sort((x, y) => x - y)
  const medianSpan = spans.length ? spans[Math.floor(spans.length / 2)] : 0
  const dateGapThreshold = Math.max(medianSpan * 0.5, GAP_MIN_DAYS)

  const gaps: StatementGap[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]
    const b = ordered[i + 1]
    const pa = period(a)
    const pb = period(b)
    const balanceBreak = !approxEqual(a.closingBalance, b.openingBalance)
    const dateBreak = pa != null && pb != null && daysBetween(pa.end, pb.start) > dateGapThreshold
    if (balanceBreak || dateBreak) {
      gaps.push({
        afterClosingBalance: a.closingBalance,
        nextOpeningBalance: b.openingBalance,
        beforeEnd: pa?.end ?? null,
        afterStart: pb?.start ?? null,
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
    fullyChained: gaps.length === 0,
  }
}
