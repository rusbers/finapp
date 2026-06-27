/**
 * Deterministic parser for permanent tsb (PTSB) Current Account statements.
 *
 * PTSB renders the statement body in an ANTI-EXTRACTION font ("AllAndNone", a CFF
 * CIDFont): the glyphs display correctly but the text layer is scrambled — the
 * ToUnicode map has ZERO digit mappings and no glyph names, so amounts cannot be
 * read as text the normal way. The column POSITIONS are clean, though, and a
 * Balance is printed on (almost) every row.
 *
 * So we decode the cipher from arithmetic, not from the font:
 *   1. Read positions (header anchors: Date | Details | Withdrawn | Paid In | Balance).
 *   2. The money cells are sequences of a small, fixed set of "digit symbols" plus a
 *      decimal symbol (always 3 from the end). Each amount is therefore a positional
 *      number whose digit VALUES are unknown — but a LINEAR function of them.
 *   3. The running balance gives hundreds of equations: balance = prevBalance +
 *      Σ(signed movements since the last printed balance). Solve the symbol→digit
 *      bijection (DFS, all-different) — hundreds of tight constraints ⇒ a unique
 *      solution. Reconciliation downstream is the final proof.
 *   4. Dates: day/year are digits (solved); the 3-letter month maps via a fixed
 *      table (the AllAndNone code→letter map is constant across PTSB statements).
 *      Descriptions are decoded best-effort with the same fixed letter map.
 *
 * If the solver can't find a UNIQUE digit map (an unexpected layout/font), the
 * parser returns ZERO transactions, which makes the pipeline fall back to AI vision.
 */

import type { StatementData, Transaction } from "./types"
import { loadPdfjs } from "./pdf-loader"

const Y_TOL = 2.5
const MAX_SOLVE_NODES = 8_000_000

// Fixed AllAndNone code→char map (the font subset is constant across PTSB
// statements; digits are re-derived per-document by the solver, but the month
// table and description letters rely on this map). Lowercase only.
const MONTH_BY_TRIPLE: Record<string, number> = {
  "91,32,43": 1, "227,225,226": 2, "40,32,234": 3, "32,38,234": 4,
  "40,32,223": 5, "91,237,43": 6, "91,237,60": 7, "32,237,229": 8,
  "235,225,38": 9, "33,228,232": 10, "43,33,238": 11, "224,225,228": 12,
}
const LETTER_BY_CODE: Record<number, string> = {
  32: "a", 33: "o", 38: "p", 40: "m", 43: "n", 60: "l", 91: "j", 223: "y",
  224: "d", 225: "e", 226: "b", 227: "f", 228: "c", 229: "g", 232: "t",
  234: "r", 235: "s", 237: "u", 238: "v",
}

interface Tok { text: string; x0: number; x1: number; y: number }
interface Cell { codes: number[] }
interface Row { date: Tok[]; details: Tok[]; withdrawn?: Cell; paidIn?: Cell; balance?: Cell }

async function extractLines(pdfBytes: Uint8Array): Promise<{ lines: Tok[][]; anchors: Anchors } | null> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, disableWorker: true,
  }).promise
  const allLines: Tok[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const toks: Tok[] = []
    for (const it of content.items as Array<{ str: string; transform: number[]; width: number }>) {
      const text = it.str || ""
      if (!text.trim()) continue
      const x0 = it.transform[4]
      toks.push({ text, x0, x1: x0 + it.width, y: vp.height - it.transform[5] })
    }
    toks.sort((a, b) => a.y - b.y || a.x0 - b.x0)
    let cur: Tok[] = []
    let cy: number | null = null
    for (const t of toks) {
      if (cy === null || Math.abs(t.y - cy) <= Y_TOL) { cur.push(t); if (cy === null) cy = t.y }
      else { allLines.push([...cur].sort((a, b) => a.x0 - b.x0)); cur = [t]; cy = t.y }
    }
    if (cur.length) allLines.push([...cur].sort((a, b) => a.x0 - b.x0))
  }
  const anchors = detectAnchors(allLines)
  return anchors ? { lines: allLines, anchors } : null
}

interface Anchors { date: number; details: number; withdrawn: number; paidIn: number; balance: number }
function detectAnchors(lines: Tok[][]): Anchors | null {
  for (const line of lines) {
    const txt = line.map((t) => t.text).join(" ")
    if (/Date/.test(txt) && /Details/.test(txt) && /Balance/.test(txt) && /Paid/.test(txt)) {
      const f = (re: RegExp) => line.find((t) => re.test(t.text))
      const d = f(/^Date/), de = f(/^Details/), w = f(/^Withdrawn/), pi = f(/^Paid/), b = f(/^Balance/)
      if (d && de && w && pi && b) return { date: d.x0, details: de.x0, withdrawn: w.x0, paidIn: pi.x0, balance: b.x0 }
    }
  }
  return null
}

const cc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0))
const isAsciiAlnum = (n: number) => (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122)

/** A money cell: no spaces, no ASCII alphanumerics (scrambled font), length >= 4. */
function amountCell(t: Tok): Cell | null {
  const codes = cc(t.text)
  if (codes.length < 4 || codes.some((n) => n === 32 || isAsciiAlnum(n))) return null
  return { codes }
}

/** Split a line into Date / Details / money cells using the column anchors. */
const MONEY_KEYS = ["withdrawn", "paidIn", "balance"] as const
type MoneyKey = (typeof MONEY_KEYS)[number]
function splitRow(line: Tok[], a: Anchors): Row {
  const row: Row = { date: [], details: [] }
  const colX: Record<MoneyKey, number> = { withdrawn: a.withdrawn, paidIn: a.paidIn, balance: a.balance }
  for (const t of line) {
    const cell = t.x0 >= a.withdrawn - 30 ? amountCell(t) : null
    if (cell) {
      let best: MoneyKey = "withdrawn"
      for (const k of MONEY_KEYS) if (Math.abs(t.x0 - colX[k]) < Math.abs(t.x0 - colX[best])) best = k
      row[best] = cell
      continue
    }
    if (t.x0 < a.details - 15) row.date.push(t)
    else if (t.x0 < a.withdrawn - 30) row.details.push(t)
  }
  return row
}

// --- cipher solving -------------------------------------------------------

function findDecimal(rows: Row[]): number {
  const counts = new Map<number, number>()
  for (const r of rows) for (const c of [r.withdrawn, r.paidIn, r.balance]) if (c && c.codes.length >= 3) { const k = c.codes[c.codes.length - 3]; counts.set(k, (counts.get(k) ?? 0) + 1) }
  let best = -1, bestN = 0
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k }
  return best
}

function findDigitSet(rows: Row[], decimal: number): Set<number> {
  const freq = new Map<number, number>()
  for (const r of rows) for (const c of [r.withdrawn, r.paidIn, r.balance]) {
    if (!c || c.codes.length < 3 || c.codes[c.codes.length - 3] !== decimal) continue
    for (let i = 0; i < c.codes.length; i++) { if (i === c.codes.length - 3) continue; const k = c.codes[i]; freq.set(k, (freq.get(k) ?? 0) + 1) }
  }
  const max = Math.max(...freq.values(), 1)
  return new Set([...freq].filter(([, n]) => n >= max * 0.02).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k))
}

/** An amount cell → place-value terms (in cents): symbol → coefficient. */
function terms(codes: number[], decimal: number, digitSet: Set<number>): Map<number, number> | null {
  const di = codes.length - 3
  if (codes[di] !== decimal) return null
  const digits = [...codes.slice(0, di), ...codes.slice(di + 1)]
  if (digits.some((d) => d === decimal || !digitSet.has(d))) return null
  const m = new Map<number, number>()
  for (let i = 0; i < digits.length; i++) { const place = Math.pow(10, i); const sym = digits[digits.length - 1 - i]; m.set(sym, (m.get(sym) ?? 0) + place) }
  return m
}

type Item = { kind: "move"; sign: number; terms: Map<number, number> } | { kind: "bal"; terms: Map<number, number> }
function normalize(rows: Row[], decimal: number, digitSet: Set<number>): Item[] {
  const items: Item[] = []
  for (const r of rows) {
    const w = r.withdrawn ? terms(r.withdrawn.codes, decimal, digitSet) : null
    const p = r.paidIn ? terms(r.paidIn.codes, decimal, digitSet) : null
    if (w) items.push({ kind: "move", sign: -1, terms: w })
    else if (p) items.push({ kind: "move", sign: 1, terms: p })
    const b = r.balance ? terms(r.balance.codes, decimal, digitSet) : null
    if (b) items.push({ kind: "bal", terms: b })
  }
  return items
}

interface Eq { coeff: Map<number, number>; syms: number[] }
function buildEqs(items: Item[]): Eq[] {
  const eqs: Eq[] = []
  let lastBal: Map<number, number> | null = null
  let accum: { sign: number; terms: Map<number, number> }[] = []
  for (const it of items) {
    if (it.kind === "move") { accum.push({ sign: it.sign, terms: it.terms }); continue }
    if (lastBal) {
      const coeff = new Map<number, number>()
      for (const [s, c] of it.terms) coeff.set(s, (coeff.get(s) ?? 0) + c)
      for (const [s, c] of lastBal) coeff.set(s, (coeff.get(s) ?? 0) - c)
      for (const m of accum) for (const [s, c] of m.terms) coeff.set(s, (coeff.get(s) ?? 0) - m.sign * c)
      for (const [s, c] of [...coeff]) if (c === 0) coeff.delete(s)
      if (coeff.size) eqs.push({ coeff, syms: [...coeff.keys()] })
    }
    lastBal = it.terms
    accum = []
  }
  return eqs
}

/** Solve symbol→digit (all-different) so every equation Σ coeff*digit == 0.
 * Returns the unique map, or null if none/ambiguous. */
function solveDigits(eqs: Eq[], symbols: number[]): Map<number, number> | null {
  if (!symbols.length) return null
  const idx = new Map(symbols.map((s, i) => [s, i]))
  const eqMeta = eqs.map((e) => ({ syms: e.syms.map((s) => idx.get(s)!), coeff: e.syms.map((s) => e.coeff.get(s)!) }))
  const assign = new Array(symbols.length).fill(-1)
  const used = new Array(10).fill(false)
  const sols: number[][] = []
  let nodes = 0
  const freq = new Array(symbols.length).fill(0)
  for (const e of eqMeta) for (const si of e.syms) freq[si]++
  const order = [...symbols.keys()].sort((a, b) => freq[b] - freq[a])
  const ok = (): boolean => {
    for (const e of eqMeta) { let sum = 0, full = true; for (let k = 0; k < e.syms.length; k++) { const v = assign[e.syms[k]]; if (v < 0) { full = false; break } sum += e.coeff[k] * v } if (full && sum !== 0) return false }
    return true
  }
  const dfs = (oi: number): void => {
    if (sols.length > 1 || ++nodes > MAX_SOLVE_NODES) return
    if (oi === order.length) { if (ok()) sols.push([...assign]); return }
    const si = order[oi]
    for (let d = 0; d <= 9; d++) {
      if (used[d]) continue
      assign[si] = d; used[d] = true
      if (ok()) dfs(oi + 1)
      assign[si] = -1; used[d] = false
    }
  }
  dfs(0)
  if (sols.length !== 1) return null
  return new Map(symbols.map((s, i) => [s, sols[0][i]]))
}

const decode = (t: Map<number, number>, digit: Map<number, number>): number => {
  let cents = 0
  for (const [s, c] of t) { const d = digit.get(s); if (d === undefined) return NaN; cents += d * c }
  return cents
}

/** Decode a date cell ("DD" + 3-letter month + "YY") → ISO date, or "". */
function decodeDate(toks: Tok[], digit: Map<number, number>): string {
  const codes = toks.flatMap((t) => cc(t.text))
  const digIdx = codes.map((c, i) => (digit.has(c) ? i : -1)).filter((i) => i >= 0)
  if (digIdx.length < 4) return ""
  const day = `${digit.get(codes[digIdx[0]])}${digit.get(codes[digIdx[1]])}`
  const yy = `${digit.get(codes[digIdx[digIdx.length - 2]])}${digit.get(codes[digIdx[digIdx.length - 1]])}`
  const monCodes = codes.slice(digIdx[1] + 1, digIdx[digIdx.length - 2])
  const month = MONTH_BY_TRIPLE[monCodes.join(",")]
  if (!month) return ""
  return `20${yy}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`
}

/** Best-effort description decode with the fixed letter+digit map. */
function decodeText(toks: Tok[], digit: Map<number, number>): string {
  return toks
    .map((t) => Array.from(t.text).map((ch) => {
      const n = ch.charCodeAt(0)
      if (digit.has(n)) return String(digit.get(n))
      if (LETTER_BY_CODE[n]) return LETTER_BY_CODE[n]
      if (n === 6) return "."
      return ""
    }).join(""))
    .filter((s) => s)
    .join(" ")
    .trim()
}

export async function parsePtsb(pdfBytes: Uint8Array): Promise<StatementData> {
  const empty: StatementData = { bank: "PTSB", openingBalance: 0, closingBalance: 0, transactions: [] }
  const extracted = await extractLines(pdfBytes)
  if (!extracted) return empty
  const { lines, anchors } = extracted

  const rows = lines.map((l) => splitRow(l, anchors))
  const decimal = findDecimal(rows)
  if (decimal < 0) return empty
  const digitSet = findDigitSet(rows, decimal)
  const items = normalize(rows, decimal, digitSet)
  const eqs = buildEqs(items)
  const symset = new Set<number>()
  for (const e of eqs) for (const s of e.syms) symset.add(s)
  const digit = solveDigits(eqs, [...symset])
  if (!digit) return empty // ambiguous/unsolved → AI fallback

  // Second pass: build transactions in order, reconstructing the running balance.
  const transactions: Transaction[] = []
  let opening: number | null = null
  let closing = 0
  let running = 0
  let currentDate = ""
  for (const r of rows) {
    if (r.date.length) { const d = decodeDate(r.date, digit); if (d) currentDate = d }
    const w = r.withdrawn ? terms(r.withdrawn.codes, decimal, digitSet) : null
    const p = r.paidIn ? terms(r.paidIn.codes, decimal, digitSet) : null
    const bal = r.balance ? terms(r.balance.codes, decimal, digitSet) : null

    if (w || p) {
      const debit = w ? decode(w, digit) / 100 : 0
      const credit = p ? decode(p, digit) / 100 : 0
      if (Number.isNaN(debit) || Number.isNaN(credit)) continue
      running = Math.round((running + credit - debit) * 100) / 100
      transactions.push({ date: currentDate, description: decodeText(r.details, digit), debit, credit, balance: running })
    } else if (bal) {
      const v = decode(bal, digit) / 100
      if (!Number.isNaN(v)) { if (opening === null) { opening = v; running = v } else closing = v }
    }
    if (bal && (w || p)) { const v = decode(bal, digit) / 100; if (!Number.isNaN(v)) closing = v }
  }

  return {
    bank: "permanent tsb",
    openingBalance: opening ?? 0,
    closingBalance: closing || (transactions.length ? transactions[transactions.length - 1].balance! : 0),
    transactions,
  }
}
