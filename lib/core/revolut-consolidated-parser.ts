/**
 * Deterministic parser for Revolut "Custom / consolidated statements".
 *
 * A consolidated statement is a SINGLE PDF that bundles ALL of a user's accounts
 * (multiple current accounts in different currencies, plus savings & crypto) with
 * lots of summary/info pages. This is a DIFFERENT document from the per-account
 * Revolut statement, so it gets its OWN parser — `revolut-parser.ts` is untouched.
 *
 * MVP scope: the **Current Accounts** transaction sections only (one per currency).
 * Savings and crypto sections are intentionally ignored for now.
 *
 * Layout of a current-account transaction table (measured, identical EN/RO/RU):
 *   Date (x0≈40) | Description (x0≈125) | Category (x0≈258) |
 *   Money in/out — a SINGLE signed amount (x0≈343, e.g. "€50.00" / "-€50.00") |
 *   Balance (x0≈385) | Tax withheld (x0≈428) | Other taxes (x0≈470) | Fees (x0≈533)
 *
 * Each "Personal Account (EUR)" / "Cont personal (EUR)" / "Личный счет (EUR)" title
 * (size ≈9.6) starts a new account; the currency is the code in parentheses. We
 * reconcile each account separately (its own balance series & currency).
 */

import type { Transaction } from "./types"
import { loadPdfjs } from "./pdf-loader"

export interface ConsolidatedAccount {
  label: string // e.g. "Personal Account (EUR)"
  currency: string // "EUR", "RON", ...
  openingBalance: number
  closingBalance: number
  transactions: Transaction[]
}

export interface ConsolidatedStatement {
  bank: string
  accounts: ConsolidatedAccount[]
}

// --- column geometry ---
// Left of X_DESC = Date column; left of X_RIGHT = Description + Category. Right of
// X_RIGHT are the money columns (signed amount, Balance, Tax, Other taxes, Fees) —
// the amount column starts ~324-343 depending on language, Category ends ~304.
// X_DESC sits in the gap between the Date column's right edge (x1 ≤ ~98, even for
// the widest RU date "20 нояб. 2025г.") and the Description column's start. That
// start is locale-dependent: ~124.8 in EN/RO but ~118.5 in RU — so the old 120
// pulled the RU description into the Date column. 110 separates all three locales.
const X_DESC = 110
// The Category column starts here (RU ~244, EN/RO ~256), and descriptions end well
// before it (separate-token descriptions reach x1 ≤ ~235). Splitting at 240 keeps
// the description and drops a SEPARATE category token. (Glued cells — where pdfjs
// merges Description+Category into one token — are handled by suffix-stripping below.)
const X_CATEGORY = 240
const X_RIGHT = 308
const MAIN_MIN_SIZE = 7

// One money value, grouping-aware so it works across all Revolut number formats
// and never spans two values: optional sign/symbol, 1-3 digits, zero+ groups of
// exactly 3 digits (space/comma/dot/nbsp separator), then a 2-decimal fraction.
// Matches "1,000.00", "1.000,00", "9 271,00", "100,00€", "€6,081.13", "-403.80".
const VALUE_RE = /-?\s*[€$£]?\s*\d{1,3}(?:[ .,  ]\d{3})*[.,]\d{2}/g

// Section boundaries (size ≈12.4 titles), localized EN / RO / RU.
const SECTION_START =
  /current accounts transaction statements|conturi curente extrasuri de tranzac|текущие счета выписки по операциям/i
const SECTION_STOP =
  /information about|informații despre|informaţii despre|информация о выписке|savings accounts|crypto|conturi de economii|economii|сбережени|крипто/i
// Per-account title (size ≈9.6), currency in parentheses.
const ACCOUNT_TITLE = /(?:personal account|cont personal|личный счет)\s*\(([a-zA-Z]{3})\)/i

interface Token {
  text: string
  x0: number
  x1: number
  y: number
  size: number
}
interface Line {
  size: number
  tokens: Token[]
  text: string
}

/** Has a digit + a currency marker (symbol anywhere or 3-letter code). */
function isMoney(text: string): boolean {
  return /[0-9]/.test(text) && (/[€$£]/.test(text) || /[A-Z]{3}\b/.test(text))
}

/** Parse a money token to a number (both EN "1,234.56" and EU "1.234,56"). */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^0-9.,-]/g, "")
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === ",") return null
  const lastDot = cleaned.lastIndexOf(".")
  const lastComma = cleaned.lastIndexOf(",")
  let normalized = cleaned
  // keep a leading sign, normalize the decimal separator
  const neg = cleaned.trimStart().startsWith("-")
  const digits = cleaned.replace(/-/g, "")
  if (lastDot >= 0 || lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ","
    const thousandsSep = decimalSep === "." ? "," : "."
    normalized = digits.split(thousandsSep).join("").replace(decimalSep, ".")
  } else {
    normalized = digits
  }
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  // Romanian
  ian: "01", mai: "05", iun: "06", iul: "07", noi: "11",
  // Russian
  янв: "01", фев: "02", мар: "03", апр: "04", май: "05", мая: "05", июн: "06",
  июл: "07", авг: "08", сен: "09", окт: "10", ноя: "11", дек: "12",
}

/** "5 Mar 2025" / "5 mar. 2025" / "5 мар. 2025" → "2025-03-05" (or "" if no match). */
function toIsoDate(raw: string): string {
  const m = raw.match(/(\d{1,2})\s+([a-zA-ZăâîЀ-ӿ]+)\.?\s+(\d{4})/)
  if (!m) return ""
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
  if (!month) return ""
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`
}

async function extractPages(pdfBytes: Uint8Array): Promise<Line[][]> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes), // pdfjs detaches the buffer it's given
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    disableWorker: true,
  }).promise
  const pages: Line[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const vh = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const tokens: Token[] = []
    for (const item of content.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      const text = (item.str || "").trim()
      if (!text) continue
      const x0 = item.transform[4]
      tokens.push({ text, x0, x1: x0 + item.width, y: vh - item.transform[5], size: item.height || 0 })
    }
    tokens.sort((a, b) => a.y - b.y || a.x0 - b.x0)
    const lines: Line[] = []
    let cur: Token[] = []
    let cy: number | null = null
    const flush = () => {
      if (!cur.length) return
      const sorted = [...cur].sort((a, b) => a.x0 - b.x0)
      lines.push({
        size: Math.max(...sorted.map((t) => t.size)),
        tokens: sorted,
        text: sorted.map((t) => t.text).join(" "),
      })
    }
    for (const t of tokens) {
      if (cy === null || Math.abs(t.y - cy) <= 3) {
        cur.push(t)
        if (cy === null) cy = t.y
      } else {
        flush()
        cur = [t]
        cy = t.y
      }
    }
    flush()
    pages.push(lines)
  }
  return pages
}

export async function parseRevolutConsolidated(pdfBytes: Uint8Array): Promise<ConsolidatedStatement> {
  const pages = await extractPages(pdfBytes)
  const accounts: ConsolidatedAccount[] = []
  // Categories seen as their OWN token (right of X_CATEGORY) — used afterwards to
  // strip a glued category off the end of a description.
  const categorySet = new Set<string>()
  let started = false
  let done = false
  let acc: ConsolidatedAccount | null = null

  for (const lines of pages) {
    if (done) break
    for (const line of lines) {
      if (!started) {
        if (line.size >= 12 && SECTION_START.test(line.text)) started = true
        continue
      }
      // Inside the Current Accounts transaction section.
      if (line.size >= 12 && SECTION_STOP.test(line.text)) {
        done = true
        break
      }
      const m = line.size >= 9 ? ACCOUNT_TITLE.exec(line.text) : null
      if (m) {
        acc = { label: line.text.trim(), currency: m[1].toUpperCase(), openingBalance: 0, closingBalance: 0, transactions: [] }
        accounts.push(acc)
        continue
      }
      if (!acc || line.size < MAIN_MIN_SIZE) continue

      // A transaction row starts with a real date (day month year) in the date
      // column. This excludes the table header, totals, and wrapped lines.
      const dateRaw = line.tokens
        .filter((t) => t.x0 < X_DESC && !isMoney(t.text))
        .map((t) => t.text)
        .join(" ")
        .trim()
      if (!/^\d{1,2}\s+\S/.test(dateRaw) || !/\d{4}/.test(dateRaw)) continue

      // The money columns (amount, balance, tax, other, fees) are right of X_RIGHT.
      // Extract their values with the grouping-aware regex — this also splits an
      // amount+balance that pdfjs merged into one token. amount = 1st, balance = 2nd.
      const rightText = line.tokens
        .filter((t) => t.x0 >= X_RIGHT)
        .sort((a, b) => a.x0 - b.x0)
        .map((t) => t.text)
        .join(" ")
      const vals: number[] = []
      for (const s of rightText.match(VALUE_RE) ?? []) {
        const v = parseAmount(s)
        if (v !== null) vals.push(v)
      }
      if (vals.length < 2) continue // not a transaction row
      const amount = vals[0]
      const balance = vals[1]
      const description = line.tokens
        .filter((t) => t.x0 >= X_DESC && t.x0 < X_CATEGORY && !isMoney(t.text))
        .map((t) => t.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

      // The row's Category, when it's a SEPARATE token (right of X_CATEGORY).
      // Remember it so we can also strip it where it was glued to a description.
      const category = line.tokens
        .filter((t) => t.x0 >= X_CATEGORY && t.x0 < X_RIGHT && !isMoney(t.text))
        .map((t) => t.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (category) categorySet.add(category)

      acc.transactions.push({
        date: toIsoDate(dateRaw) || dateRaw,
        description,
        debit: amount < 0 ? -amount : 0,
        credit: amount > 0 ? amount : 0,
        balance,
      })
    }
  }

  // pdfjs sometimes MERGES the Category cell into the Description token (one token
  // spanning both, with no separate category token), so a positional x-split can't
  // remove it. Strip a trailing category phrase using the categories that DID
  // appear as their own token elsewhere in the document (longest match first).
  const cats = [...categorySet].sort((a, b) => b.length - a.length)
  for (const a of accounts) {
    for (const t of a.transactions) {
      for (const c of cats) {
        if (t.description === c) {
          t.description = ""
          break
        }
        if (t.description.endsWith(" " + c)) {
          t.description = t.description.slice(0, -(c.length + 1)).trim()
          break
        }
      }
    }
  }

  // Opening = first row's balance minus its movement; closing = last row's balance.
  for (const a of accounts) {
    if (a.transactions.length) {
      const f = a.transactions[0]
      a.openingBalance = (f.balance ?? 0) - f.credit + f.debit
      a.closingBalance = a.transactions[a.transactions.length - 1].balance ?? 0
    }
  }

  return { bank: "Revolut (consolidated)", accounts }
}
