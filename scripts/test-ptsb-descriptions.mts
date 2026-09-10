/**
 * Headless test for the PTSB description layer's MATCHING rules
 * (`graftChunk` in lib/core/ptsb-descriptions.ts). Pure asserts — no PDF, no AI.
 *
 * What matters here is not that descriptions get filled, but that they are only ever
 * attached to the RIGHT row: the vision model is trusted for text and never for
 * numbers, so a row is relabelled only when the model's own reading of that row's
 * Withdrawn/Paid In agrees to the cent. Every other case must degrade to the parser's
 * partial decode rather than mislabel a transaction.
 *
 * Usage: npm run test:ptsb-descriptions
 */

import { graftChunk, type PtsbDescriptionStats } from "../lib/core/ptsb-descriptions"
import type { DescribedRow } from "../lib/core/gemini"
import type { Transaction } from "../lib/core/types"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}`)
  if (!cond) failures += 1
}

const tx = (debit: number, credit: number, description: string, descriptionKey?: string): Transaction => ({
  date: "2025-01-01",
  description,
  debit,
  credit,
  balance: null,
  page: 1,
  ...(descriptionKey ? { descriptionKey } : {}),
})
const ai = (withdrawn: number | null, paidIn: number | null, description: string): DescribedRow => ({
  withdrawn,
  paidIn,
  description,
})
const run = (rows: Transaction[], aiRows: DescribedRow[]) => {
  const stats: PtsbDescriptionStats = {
    rows: rows.length,
    filled: 0,
    reused: 0,
    chunksSent: 1,
    chunksFailed: 0,
    chunksRetried: 0,
  }
  const confirmed = new Map<string, string>()
  const filled = new Set<Transaction>()
  graftChunk(rows, aiRows, confirmed, filled, stats)
  return { stats, confirmed, filled }
}
const descriptions = (rows: Transaction[]) => rows.map((r) => r.description).join("|")

// ---------------------------------------------------------------------------
// 1. The straightforward case: same rows, same order.
// ---------------------------------------------------------------------------
console.log("# 1. Exact one-to-one match")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2"), tx(3.99, 0, "frag3")]
  const { stats } = run(rows, [ai(10, null, "TESCO STORES"), ai(null, 25.5, "SALARY"), ai(3.99, null, "SPOTIFY")])
  check("every row filled", stats.filled === 3)
  check("descriptions land on the right rows", descriptions(rows) === "TESCO STORES|SALARY|SPOTIFY")
}

// ---------------------------------------------------------------------------
// 2. The model invents an extra row (a wrapped line read as its own row).
// ---------------------------------------------------------------------------
console.log("\n# 2. Spurious extra row from the model")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2")]
  const { stats } = run(rows, [
    ai(10, null, "TESCO STORES"),
    ai(null, null, "CONTINUATION LINE"), // no amounts, so not a transaction
    ai(null, 25.5, "SALARY"),
  ])
  check("both real rows still filled", stats.filled === 2)
  check("the extra row is skipped, not absorbed", rows[1].description === "SALARY")
}

// ---------------------------------------------------------------------------
// 3. The model misses a row entirely — that row keeps its partial decode.
// ---------------------------------------------------------------------------
console.log("\n# 3. Model drops a row")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2"), tx(3.99, 0, "frag3")]
  const { stats } = run(rows, [ai(10, null, "TESCO STORES"), ai(3.99, null, "SPOTIFY")])
  check("only the read rows are filled", stats.filled === 2)
  check("the missed row keeps its partial decode", rows[1].description === "frag2")
  check("the later row is still matched correctly", rows[2].description === "SPOTIFY")
}

// ---------------------------------------------------------------------------
// 4. Amounts disagree — the row must NOT be relabelled. This is the safety rule.
// ---------------------------------------------------------------------------
console.log("\n# 4. Amount mismatch is refused")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2")]
  const { stats } = run(rows, [ai(10.01, null, "WRONG ROW"), ai(null, 25.5, "SALARY")])
  check("a one-cent difference is enough to refuse", rows[0].description === "frag1")
  check("only the matching row is filled", stats.filled === 1)
  check("the good row is still filled", rows[1].description === "SALARY")
}

// ---------------------------------------------------------------------------
// 5. Debit/credit direction must agree too — same magnitude is not a match.
// ---------------------------------------------------------------------------
console.log("\n# 5. Direction must agree")
{
  const rows = [tx(40, 0, "frag-debit")]
  const { stats } = run(rows, [ai(null, 40, "REFUND")])
  check("a credit reading never fills a debit row", rows[0].description === "frag-debit")
  check("nothing filled", stats.filled === 0)
}

// ---------------------------------------------------------------------------
// 6. An empty description from the model is ignored (never blanks a row).
// ---------------------------------------------------------------------------
console.log("\n# 6. Empty model description is ignored")
{
  const rows = [tx(10, 0, "frag1")]
  const { stats } = run(rows, [ai(10, null, "")])
  check("row keeps its partial decode", rows[0].description === "frag1")
  check("nothing counted as filled", stats.filled === 0)
}

// ---------------------------------------------------------------------------
// 7. descriptionKey: a confirmed reading is remembered for reuse elsewhere.
// ---------------------------------------------------------------------------
console.log("\n# 7. Confirmed readings are keyed for reuse")
{
  const rows = [tx(10, 0, "frag1", "K1"), tx(0, 25.5, "frag2", "K2")]
  const { confirmed } = run(rows, [ai(10, null, "TESCO STORES"), ai(null, 25.5, "SALARY")])
  check("both keys recorded", confirmed.get("K1") === "TESCO STORES" && confirmed.get("K2") === "SALARY")
  check("only real keys are recorded", confirmed.size === 2)
}

// ---------------------------------------------------------------------------
// 8. Repeated amounts: order decides, so identical rows keep their own reading.
// ---------------------------------------------------------------------------
console.log("\n# 8. Repeated amounts are matched in order")
{
  const rows = [tx(9.99, 0, "a"), tx(9.99, 0, "b"), tx(9.99, 0, "c")]
  run(rows, [ai(9.99, null, "FIRST"), ai(9.99, null, "SECOND"), ai(9.99, null, "THIRD")])
  check("each row gets its own reading in order", descriptions(rows) === "FIRST|SECOND|THIRD")
}

// ---------------------------------------------------------------------------
// 9. No readings at all (a failed chunk) leaves everything untouched.
// ---------------------------------------------------------------------------
console.log("\n# 9. No readings changes nothing")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2")]
  const { stats } = run(rows, [])
  check("nothing filled", stats.filled === 0)
  check("descriptions untouched", descriptions(rows) === "frag1|frag2")
}

// ---------------------------------------------------------------------------
// 10. The layer never touches numbers, dates or balances.
// ---------------------------------------------------------------------------
console.log("\n# 10. Numbers are never touched")
{
  const rows = [tx(10, 0, "frag1"), tx(0, 25.5, "frag2")]
  const shape = (r: Transaction) => `${r.date}|${r.debit}|${r.credit}|${r.balance}|${r.page}`
  const before = rows.map(shape).join("#")
  run(rows, [ai(10, null, "TESCO STORES"), ai(null, 25.5, "SALARY")])
  check("date/debit/credit/balance/page identical after grafting", rows.map(shape).join("#") === before)
}

// ---------------------------------------------------------------------------
// 11. A far-away row with the same amounts is out of the lookahead window, so a
//     dropped row cannot silently steal a description from much later in the page.
// ---------------------------------------------------------------------------
console.log("\n# 11. Matching does not reach beyond the lookahead window")
{
  const rows = [tx(5, 0, "target")]
  const far = Array.from({ length: 12 }, (_, i) => ai(100 + i, null, `NOISE ${i}`))
  const { stats } = run(rows, [...far, ai(5, null, "TOO FAR AWAY")])
  check("row keeps its partial decode", rows[0].description === "target")
  check("nothing filled", stats.filled === 0)
}

console.log(failures === 0 ? "\nAll PTSB description checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
