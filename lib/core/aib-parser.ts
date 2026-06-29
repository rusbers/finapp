/**
 * Deterministic parser for AIB (Allied Irish Banks) Personal Bank Account
 * statements. Ported from a positional analysis validated on real statements
 * (every printed balance checkpoint reconciled to the cent across 5 pages and
 * two different branches/accounts).
 *
 * AIB's layout differs fundamentally from Revolut's:
 *   - Columns: Date | Details | Debit € | Credit € | Balance €
 *   - The three money columns are RIGHT-aligned, and their absolute X positions
 *     SCALE WITH PAGE WIDTH (e.g. 601pt vs 595pt → all anchors × 595/601). So we
 *     detect the anchors PER PAGE from the header row (the € tokens), never
 *     hardcoding them.
 *   - One transaction spans several lines; the running Balance is printed only
 *     sporadically (a checkpoint at the end of a block), NOT on every row. So a
 *     transaction is identified by carrying a Debit OR Credit amount — the
 *     presence of a Balance is irrelevant to that decision.
 *   - The Date appears only on the first line of each day and is inherited
 *     downward until the next date.
 *   - Overdraft balances carry a glued 'dr' suffix (e.g. '3.78dr' = -3.78),
 *     which sits ~8pt to the right of the normal Balance edge.
 *   - 'Interest Rate' / 'Lending @ x%' are informational rows (no posting).
 *   - Foreign-currency lines put the original amount / FX rate / FX fee in the
 *     Details column; only the EUR value lands in a money column.
 *   - A right-hand info sidebar (x0 > ~0.72 × width) is ignored.
 *
 * We reconstruct a full per-transaction running balance from the opening
 * BALANCE FORWARD; reconciliation downstream validates it against the declared
 * opening/closing balances.
 */

import type { StatementData, Transaction } from "./types";
import { loadPdfjs } from "./pdf-loader";

// pdfjs is loaded lazily (see pdf-loader.ts) so it stays off the AI path and its
// ESM/worker quirks are isolated to parse time — important on serverless.

// --- Region boundaries as fractions of page width (scale-invariant) ---
const DATE_COL_RIGHT_FRAC = 0.13; // tokens whose x1 is below this are the Date column
const MONEY_LEFT_FRAC = 0.30;     // a numeric token left of this is descriptive, not a posting
const SIDEBAR_LEFT_FRAC = 0.72;   // tokens whose x0 is beyond this are the right-hand notes
const REJECT_DIST_FRAC = 0.08;    // an amount further than this from any anchor isn't a posting
const Y_TOL = 2;                  // tokens within this Y distance are the same visual line

const AMOUNT_RE = /^(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(dr)?$/;
const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/;
const LENDING_RE = /^Lending @ .*%$/i;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const STOP_MARKERS = [
  "This is an eligible deposit",
  "For Important Information",
  "Overdrawn balances are marked",
];

const SKIP_DESCRIPTIONS = new Set(["Interest Rate"]); // + 'Lending @ x%' via regex

interface Token {
  text: string;
  x0: number;
  x1: number;
  y: number; // top-down (smaller = higher on the page)
  size: number;
}

interface Line {
  y: number;
  tokens: Token[]; // sorted left-to-right
}

type Column = "debit" | "credit" | "balance";
type Anchors = Partial<Record<Column, number>>;

/** Extract tokens (text + position + size) for every page. */
async function extractPages(pdfBytes: Uint8Array): Promise<{ tokens: Token[]; width: number }[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes), // pdfjs detaches the buffer it's given; copy so the caller's bytes survive
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    disableWorker: true,
  }).promise;
  const pages: { tokens: Token[]; width: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const tokens: Token[] = [];
    for (const item of content.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      const text = (item.str || "").trim();
      if (!text) continue;
      const x0 = item.transform[4];
      const yTop = viewport.height - item.transform[5];
      tokens.push({ text, x0, x1: x0 + item.width, y: yTop, size: item.height || 0 });
    }
    pages.push({ tokens, width: viewport.width });
  }
  return pages;
}

/** Group tokens into visual lines by Y, each sorted left-to-right. */
function groupLines(tokens: Token[]): Line[] {
  const sorted = [...tokens].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines: Line[] = [];
  let current: Token[] = [];
  let cy: number | null = null;
  for (const t of sorted) {
    if (cy === null || Math.abs(t.y - cy) <= Y_TOL) {
      current.push(t);
      if (cy === null) cy = t.y;
    } else {
      lines.push({ y: cy, tokens: [...current].sort((a, b) => a.x0 - b.x0) });
      current = [t];
      cy = t.y;
    }
  }
  if (current.length) lines.push({ y: cy as number, tokens: [...current].sort((a, b) => a.x0 - b.x0) });
  return lines;
}

/** Parse an amount token like "1,234.56" or "3.78dr" → {value, hasDr} or null. */
function parseAmountToken(text: string): { value: number; hasDr: boolean } | null {
  const m = AMOUNT_RE.exec(text.replace(/,/g, ""));
  if (!m) return null;
  let value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const hasDr = Boolean(m[2]);
  if (hasDr) value = -value; // overdrawn balance
  return { value, hasDr };
}

/**
 * Detect the right-edge anchors {debit, credit, balance} for a page.
 *
 * pdfjs joins each header cell with its € sign ("Debit €" / "Credit €" /
 * "Balance €"). Those three header tokens are ALWAYS present and always in the
 * right order, so they give reliable per-column anchors — unlike clustering the
 * body amounts, which breaks on pages with only one or two transactions (a lone
 * balance can get misread as a credit). We take each header cell's right edge,
 * then refine it toward the body amounts that land nearest to it (the amounts
 * sit a few pt right of the header, consistently).
 */
function detectAnchors(lines: Line[], width: number): { anchors: Anchors; headerY: number | null } {
  // Find the header row and the right edge of each money-column header cell.
  let headerY: number | null = null;
  const headerEdge: Anchors = {};
  for (const line of lines) {
    const joined = line.tokens.map((t) => t.text).join(" ");
    if (/Debit/.test(joined) && /Credit/.test(joined) && /Balance/.test(joined)) {
      headerY = line.y;
      for (const t of line.tokens) {
        if (/^Debit/.test(t.text)) headerEdge.debit = t.x1;
        else if (/^Credit/.test(t.text)) headerEdge.credit = t.x1;
        else if (/^Balance/.test(t.text)) headerEdge.balance = t.x1;
      }
      break;
    }
  }

  // If we couldn't read the header, we can't safely classify — return empty.
  if (headerEdge.debit === undefined || headerEdge.credit === undefined || headerEdge.balance === undefined) {
    return { anchors: {}, headerY };
  }

  // Refine each header edge toward the modal right-edge of the body amounts that
  // are nearest to it (skip 'dr' tokens and Details-column numbers).
  const byCol: Record<Column, number[]> = { debit: [], credit: [], balance: [] };
  const cols: Column[] = ["debit", "credit", "balance"];
  for (const line of lines) {
    if (headerY !== null && line.y <= headerY + 3) continue;
    for (const t of line.tokens) {
      const m = AMOUNT_RE.exec(t.text.replace(/,/g, ""));
      if (!m || m[2]) continue;
      if (t.x0 < MONEY_LEFT_FRAC * width) continue;
      let best: Column = cols[0];
      for (const c of cols) {
        if (Math.abs(t.x1 - (headerEdge[c] as number)) < Math.abs(t.x1 - (headerEdge[best] as number))) best = c;
      }
      byCol[best].push(t.x1);
    }
  }

  const anchors: Anchors = { ...headerEdge };
  for (const c of cols) {
    const xs = byCol[c];
    if (xs.length) {
      const counts = new Map<number, number>();
      for (const x of xs) {
        const k = Math.round(x * 10) / 10;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let modal = xs[0], best = 0;
      for (const [x, n] of counts) if (n > best) { best = n; modal = x; }
      anchors[c] = modal;
    }
  }
  return { anchors, headerY };
}

/** Classify a token as a money posting → {column, value} or null. */
function classifyAmount(t: Token, anchors: Anchors, width: number): { col: Column; value: number } | null {
  const parsed = parseAmountToken(t.text);
  if (!parsed) return null;
  if (t.x0 < MONEY_LEFT_FRAC * width) return null; // numbers in Details aren't postings
  const cols = Object.keys(anchors) as Column[];
  if (!cols.length) return null;
  let best: Column = cols[0];
  for (const c of cols) {
    if (Math.abs(t.x1 - (anchors[c] as number)) < Math.abs(t.x1 - (anchors[best] as number))) best = c;
  }
  if (Math.abs(t.x1 - (anchors[best] as number)) > REJECT_DIST_FRAC * width) return null;
  return { col: best, value: parsed.value };
}

/**
 * Parse an AIB statement PDF into structured data, deterministically.
 */
export async function parseAib(pdfBytes: Uint8Array): Promise<StatementData> {
  const pages = await extractPages(pdfBytes);
  const transactions: Transaction[] = [];

  let openingBalance: number | null = null; // first BALANCE FORWARD seen
  let closingBalance: number | null = null; // last printed balance checkpoint
  let running: number | null = null;        // reconstructed running balance
  let currentDate = "";
  let sawFirstBalanceForward = false;

  for (const [pageIdx, { tokens, width }] of pages.entries()) {
    const page = pageIdx + 1;
    const lines = groupLines(tokens);
    const { anchors, headerY } = detectAnchors(lines, width);

    for (const line of lines) {
      // The header spans two sub-lines (amount headers size 10 above Date/Details
      // size 9); +3 skips both so "Details" never leaks into the body.
      if (headerY !== null && line.y <= headerY + 3) continue;

      // Drop the right-hand info sidebar.
      const bodyTokens = line.tokens.filter((t) => t.x0 < SIDEBAR_LEFT_FRAC * width);
      if (!bodyTokens.length) continue;

      const joined = bodyTokens.map((t) => t.text).join(" ");
      if (STOP_MARKERS.some((mk) => joined.includes(mk))) break; // footer for this page

      // Bucket tokens into date / description / money.
      const dateToks: Token[] = [];
      const descToks: Token[] = [];
      const moneyToks: Token[] = [];
      for (const t of bodyTokens) {
        if (classifyAmount(t, anchors, width)) moneyToks.push(t);
        else if (t.x1 < DATE_COL_RIGHT_FRAC * width) dateToks.push(t);
        else descToks.push(t);
      }

      // Date (inherited downward until the next one appears).
      if (dateToks.length) {
        const dm = DATE_RE.exec(dateToks.map((t) => t.text).join(" "));
        if (dm) {
          const month = MONTHS[dm[2].toLowerCase()];
          if (month) currentDate = `${dm[3]}-${month}-${dm[1].padStart(2, "0")}`;
        }
      }

      const description = descToks.map((t) => t.text).join(" ").trim();
      const cols: Anchors = {};
      for (const t of moneyToks) {
        const c = classifyAmount(t, anchors, width);
        if (c) cols[c.col] = c.value;
      }

      // Opening / page-forward balance row. Current accounts print "BALANCE
      // FORWARD" on every page; LOAN statements print "OPENING BALANCE" on page 1
      // (often 0.00, before the drawdown) and "BALANCE FORWARD" on later pages.
      // Both are balance checkpoints, and the FIRST one is the statement's opening
      // — without recognising "OPENING BALANCE" the page-1 postings were counted
      // while the opening was taken from page 2's forward (double-count → a
      // failure by exactly the opening balance).
      const upperDesc = description.toUpperCase();
      if (upperDesc.startsWith("BALANCE FORWARD") || upperDesc.startsWith("OPENING BALANCE")) {
        if (cols.balance !== undefined) {
          running = cols.balance;
          if (!sawFirstBalanceForward) {
            openingBalance = cols.balance;
            sawFirstBalanceForward = true;
          }
        }
        continue;
      }

      // Informational rows.
      if (SKIP_DESCRIPTIONS.has(description) || LENDING_RE.test(description)) continue;

      const debit = cols.debit;
      const credit = cols.credit;
      const balance = cols.balance;

      // A transaction is any line carrying a Debit OR Credit amount.
      if (debit !== undefined || credit !== undefined) {
        const delta = (credit ?? 0) - (debit ?? 0);
        if (running !== null) running = Math.round((running + delta) * 100) / 100;
        transactions.push({
          date: currentDate,
          description,
          debit: debit ?? 0,
          credit: credit ?? 0,
          balance: running,
          page,
        });
      }

      // A printed balance is a checkpoint → it's the latest known closing balance.
      if (balance !== undefined) closingBalance = balance;
    }
  }

  return {
    bank: "AIB",
    openingBalance: openingBalance ?? 0,
    closingBalance: closingBalance ?? 0,
    transactions,
  };
}
