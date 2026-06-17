/**
 * Deterministic parser for Revolut statements.
 *
 * Instead of asking an AI to read the PDF, we read the text with its exact
 * positions (x/y) and map each value to a column by its X anchor. This is 100%
 * consistent (same input → same output) on Revolut's fixed layout.
 *
 * Column grid (PDF points, measured from real statements):
 *   - Date         : left-aligned, x0 ≈ 43
 *   - Description  : left-aligned, x0 ≈ 125
 *   - Money out    : left-aligned, x0 ≈ 335  (debit)
 *   - Money in     : left-aligned, x0 ≈ 417  (credit)
 *   - Balance      : right-aligned, x1 ≈ 556
 *
 * Hierarchy by font size:
 *   - size ≈ 8.2  → a MAIN row (one transaction)
 *   - size ≈ 4.5  → a sub-row (reference / fee / FX rate) belonging to the row above
 *
 * Key rules (learned from the real statements):
 *   1. A transaction's amounts come ONLY from its MAIN row. Sub-rows repeat the
 *      net amount in the debit column — ignore sub-row amounts.
 *   2. FX transactions keep the EUR amount on the MAIN row; the original-currency
 *      amount (e.g. "72.00 MDL") sits on a sub-row WITHOUT a € sign — ignore it.
 *   3. Informational tail sections ("Inapoiate"/"Reverted", etc.) have NO Balance
 *      column. A main row with no token at x1 ≈ 556 marks the start of that zone
 *      → stop extracting there.
 */

import type { StatementData, Transaction } from "./types"
import { loadPdfjs } from "./pdf-loader"

// --- Column anchors (PDF points) and tolerances ---
const X_DEBIT = 335 // money out, left-aligned (match on x0)
const X_CREDIT = 417 // money in, left-aligned (match on x0)
const X1_BALANCE = 556 // balance, right-aligned (match on x1)
const X_TOL = 6

const MAIN_ROW_MIN_SIZE = 7 // size >= 7 → main row; below → sub-row
const Y_TOL = 3 // tokens within this Y distance are the same line

interface Token {
  text: string
  x0: number
  x1: number
  y: number // baseline Y (top-down, normalized so smaller = higher on page)
  size: number
}

interface Line {
  y: number
  size: number // representative font size of the line
  tokens: Token[] // sorted left-to-right
  isMain: boolean
}

/** Parse a number like "€200.00" / "1,234.56" → 200.00 / 1234.56 (or null). */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^0-9.,-]/g, "").replace(/,/g, "")
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Does this token carry a currency amount (has € or $)? */
function isCurrencyToken(text: string): boolean {
  return /[€$]/.test(text) && /[0-9]/.test(text)
}

/** Extract all tokens (text + position + size) from every page, in reading order. */
async function extractTokens(pdfBytes: Uint8Array): Promise<Token[][]> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: pdfBytes,
    useSystemFonts: false,
    // On serverless there's no filesystem path for pdfjs's standard font/cmap
    // data, and we only read text positions (no rendering), so disable anything
    // that would try to fetch external resources.
    disableFontFace: true,
    isEvalSupported: false,
  }).promise

  const pages: Token[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const viewportHeight = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const tokens: Token[] = []

    for (const item of content.items as Array<{
      str: string
      transform: number[]
      width: number
      height: number
    }>) {
      const text = item.str
      if (!text || !text.trim()) continue
      const x0 = item.transform[4]
      const yBottom = item.transform[5]
      // pdfjs Y is from the bottom; convert to top-down so "smaller = higher".
      const yTop = viewportHeight - yBottom
      tokens.push({
        text: text.trim(),
        x0,
        x1: x0 + item.width,
        y: yTop,
        size: item.height || 0,
      })
    }
    pages.push(tokens)
  }
  return pages
}

/** Group a page's tokens into lines by Y, then classify main vs sub-row. */
function groupLines(tokens: Token[]): Line[] {
  const sorted = [...tokens].sort((a, b) => a.y - b.y || a.x0 - b.x0)
  const lines: Line[] = []
  let current: Token[] = []
  let currentY: number | null = null

  for (const t of sorted) {
    if (currentY === null || Math.abs(t.y - currentY) <= Y_TOL) {
      current.push(t)
      if (currentY === null) currentY = t.y
    } else {
      lines.push(makeLine(current, currentY))
      current = [t]
      currentY = t.y
    }
  }
  if (current.length) lines.push(makeLine(current, currentY!))
  return lines
}

function makeLine(tokens: Token[], y: number): Line {
  const sorted = [...tokens].sort((a, b) => a.x0 - b.x0)
  // Representative size = max token size on the line (titles/main stand out).
  const size = Math.max(...sorted.map((t) => t.size))
  return { y, size, tokens: sorted, isMain: size >= MAIN_ROW_MIN_SIZE }
}

/** A main row is a real transaction only if it has a Balance token (x1 ≈ 556). */
function hasBalance(line: Line): boolean {
  return line.tokens.some((t) => Math.abs(t.x1 - X1_BALANCE) <= X_TOL && isCurrencyToken(t.text))
}

/** Pick the amount token whose anchor matches a column; return its parsed value. */
function amountAt(line: Line, anchor: number, edge: "x0" | "x1"): number | null {
  for (const t of line.tokens) {
    if (!isCurrencyToken(t.text)) continue
    const pos = edge === "x0" ? t.x0 : t.x1
    if (Math.abs(pos - anchor) <= X_TOL) {
      return parseAmount(t.text)
    }
  }
  return null
}

/** Description = non-amount tokens at/after the description column, joined. */
function buildDescription(line: Line): string {
  const parts = line.tokens
    .filter((t) => t.x0 >= 120 && !isCurrencyToken(t.text))
    .map((t) => t.text)
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

/**
 * Is this line the transaction-table header?
 * Revolut statements come in Romanian ("Dată Descriere Sume retrase Sume
 * adăugate Sold") and English ("Date Description Money out Money in Balance").
 * We require the description column word plus a money-out/balance word so we
 * don't match the balance-summary header at the top of the statement.
 */
function isTableHeader(line: Line): boolean {
  const text = line.tokens
    .map((t) => t.text)
    .join(" ")
    .toLowerCase()
  const hasDescription = text.includes("descriere") || text.includes("description")
  const hasMoneyOut = text.includes("sume retrase") || text.includes("money out")
  const hasBalanceWord = text.includes("sold") || text.includes("balance")
  return hasDescription && hasMoneyOut && hasBalanceWord
}

/**
 * Is this line the start of an informational tail section?
 * Romanian: "Înapoiate din ...". English: "Reverted ...".
 */
function isSectionTitle(line: Line): boolean {
  if (line.size < 10) return false // section titles are large (~12.4)
  const text = line.tokens
    .map((t) => t.text)
    .join(" ")
    .toLowerCase()
  return /înapoiate|inapoiate|reverted|refunded/.test(text)
}

/**
 * Parse a Revolut statement PDF into structured data, deterministically.
 *
 * Strategy (proven on real statements):
 *   - Extraction starts only AFTER the transaction-table header row, so the
 *     balance-summary block at the top is never mistaken for transactions.
 *   - Extraction stops at the "Inapoiate"/"Reverted" tail-section title.
 *   - Each transaction's amounts come only from its MAIN row (size ≥ 7);
 *     sub-rows (fees, FX rates, references) are skipped.
 *   - Amounts are matched to columns by X anchor; only €/$ tokens count, so
 *     foreign-currency figures (e.g. "72.00 MDL") are ignored automatically.
 */
export async function parseRevolut(pdfBytes: Uint8Array): Promise<StatementData> {
  const pages = await extractTokens(pdfBytes)
  const transactions: Transaction[] = []

  let openingBalance: number | null = null
  let closingBalance: number | null = null
  let currentDate = ""
  let started = false // have we passed the transaction-table header yet?
  let reachedTail = false // have we hit the informational tail section?

  for (const pageTokens of pages) {
    if (reachedTail) break
    const lines = groupLines(pageTokens)

    for (const line of lines) {
      // Stop at the informational tail section ("Inapoiate"/"Reverted").
      if (isSectionTitle(line)) {
        reachedTail = true
        break
      }
      // Begin extracting only after the transaction-table header. (The header
      // repeats on every page, so this also re-syncs after page breaks.)
      if (isTableHeader(line)) {
        started = true
        continue
      }
      if (!started) continue
      if (!line.isMain) continue // sub-rows belong to their main row; skip them

      // Real transaction rows always carry a balance (x1 ≈ 556). Lines without
      // one are stray/non-transaction main lines — skip, don't stop.
      if (!hasBalance(line)) continue

      const debit = amountAt(line, X_DEBIT, "x0") ?? 0
      const credit = amountAt(line, X_CREDIT, "x0") ?? 0
      const balance = amountAt(line, X1_BALANCE, "x1")

      const dateText = normalizeDate(line)
      if (dateText) currentDate = dateText

      const description = buildDescription(line)

      transactions.push({
        date: currentDate,
        description,
        debit,
        credit,
        balance,
      })

      if (openingBalance === null && balance !== null) {
        openingBalance = balance - credit + debit
      }
      if (balance !== null) closingBalance = balance
    }
  }

  return {
    bank: "Revolut",
    openingBalance: openingBalance ?? 0,
    closingBalance: closingBalance ?? 0,
    transactions,
  }
}

/** Join the leftmost date tokens and convert "2 ian. 2025" → "2025-01-02". */
function normalizeDate(line: Line): string {
  const dateTokens = line.tokens
    .filter((t) => t.x0 < 125 && !isCurrencyToken(t.text))
    .map((t) => t.text)
  const raw = dateTokens.join(" ").trim()
  return toIsoDate(raw) || raw
}

const MONTHS: Record<string, string> = {
  // Romanian (as printed on RO statements, e.g. "2 ian. 2025")
  ian: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mai: "05",
  iun: "06",
  iul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  noi: "11",
  dec: "12",
  // English (e.g. "2 Jan 2025"); overlaps reuse the same 3-letter keys.
  jan: "01",
  may: "05",
  jun: "06",
  jul: "07",
  nov: "11",
  // (apr/aug/sep/oct/dec/feb/mar share spelling across both languages)
}

/** "2 ian. 2025" or "2 Jan 2025" → "2025-01-02"; returns "" if it doesn't match. */
function toIsoDate(raw: string): string {
  const m = raw.match(/(\d{1,2})\s+([a-zA-Zăâî]+)\.?\s+(\d{4})/)
  if (!m) return ""
  const day = m[1].padStart(2, "0")
  const monthKey = m[2].slice(0, 3).toLowerCase()
  const month = MONTHS[monthKey]
  if (!month) return ""
  return `${m[3]}-${month}-${day}`
}
