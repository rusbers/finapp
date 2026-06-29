/**
 * Deterministic parser for Bank of Ireland (BOI) Current Account statements.
 * Ported from a positional analysis validated on a real 7-page statement (every
 * printed balance, SUBTOTAL and per-page BALANCE FORWARD reconciled to the cent).
 *
 * BOI's layout differs from both Revolut and AIB:
 *   - Columns: Date | Transaction details | Payments-out | Payments-in | Balance
 *   - The three money columns are RIGHT-aligned and razor-tight. Their absolute
 *     X positions are detected PER PAGE from the header words ("out" / "in" /
 *     "Balance"), refined with body amounts — never hardcoded (page-width safe).
 *   - "out" and "in" are SEPARATE columns (not one signed column): the same
 *     value can appear as both an out and an in (a purchase + its refund). Only
 *     the amount's x1 distinguishes them.
 *   - ONE LINE = ONE TRANSACTION. BOI has no separate reference/detail lines.
 *   - The running Balance is printed only sporadically (last line of a day
 *     block); a block holds several postings before one balance checkpoint.
 *   - The Date ("24 Jun 2025") appears only on the first line of each day and is
 *     inherited; the compact "POSC24JUN" inside descriptions is the POS terminal
 *     date, NOT the Date column.
 *   - Overdraft is marked by a SEPARATE "OD" token to the RIGHT of the balance
 *     ("6.00 OD" = -6.00), unlike AIB's glued "dr".
 *   - "BALANCE FORWARD" = page-opening balance; "SUBTOTAL:" = page-closing
 *     balance and equals the next page's BALANCE FORWARD (day blocks may span
 *     pages). "FEE: ..." lines ARE real transactions (payments-out).
 *   - FX originals/rates are embedded in the description token
 *     ("P2908IE700.00@1.16098"); only the EUR value lands in a money column.
 *   - No right-hand sidebar. Amounts use "," thousands separators.
 *
 * We reconstruct a per-transaction running balance from the opening BALANCE
 * FORWARD; reconciliation downstream validates opening/closing.
 */

import type { StatementData, Transaction } from "./types";
import { loadPdfjs } from "./pdf-loader";

// pdfjs is loaded lazily (see pdf-loader.ts) so it stays off the AI path and its
// ESM/worker quirks are isolated to parse time — important on serverless.

// --- Region boundaries as fractions of page width (scale-invariant) ---
const DATE_RIGHT_FRAC = 0.22;  // a token whose x0 is below this is the Date column
const MONEY_LEFT_FRAC = 0.45;  // a numeric token left of this is descriptive, not a posting
const REJECT_DIST_FRAC = 0.08; // an amount further than this from any anchor isn't a posting
const OD_MARGIN = 5.0;         // an 'OD' token within this of the balance edge marks overdraft
const Y_TOL = 2;               // tokens within this Y distance are the same visual line

const AMOUNT_RE = /^(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})$/;
// An overdraft balance where pdfjs JOINED the amount and the "OD" marker into one
// token ("6.00 OD" = -6.00), instead of two separate tokens. Value is negated.
const OD_BALANCE_RE = /^(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s+OD$/;
const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

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

type Column = "out" | "in" | "balance";
type Anchors = Partial<Record<Column, number>>;

/** Extract tokens (text + position) for every page. */
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

/** Parse a plain amount token like "1,234.56" → 1234.56 (or null). */
function parseAmount(text: string): number | null {
  if (!AMOUNT_RE.test(text)) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect the right-edge anchors {out, in, balance} for a page.
 *
 * The header gives reliable per-column right edges. pdfplumber splits the header
 * into separate tokens ("Payments", "-", "out", ... "Balance"); pdfjs may join
 * them ("Payments - out"). We handle both: we find the header line (it contains
 * "Payments" and "Balance"), then locate the right edge of each money column by
 * matching the cell however it was tokenized. We then refine each edge toward the
 * modal right edge of the body amounts nearest it. Anchoring to the header
 * (always present, correctly ordered) avoids the fragility of clustering body
 * amounts on sparse pages.
 */
function detectAnchors(lines: Line[], width: number): { anchors: Anchors; headerY: number | null } {
  let headerY: number | null = null;
  let headerTokens: Token[] = [];
  for (const line of lines) {
    const joined = line.tokens.map((t) => t.text).join(" ");
    if (/Payments/.test(joined) && /Balance/.test(joined)) {
      headerY = line.y;
      headerTokens = line.tokens;
      break;
    }
  }

  const headerEdge: Anchors = {};
  for (const t of headerTokens) {
    // "out"/"in" as standalone tokens (pdfplumber) or as the tail of a joined
    // "Payments - out"/"Payments - in" token (pdfjs).
    if (t.text === "out" || /(?:^|\s|-)out$/.test(t.text)) headerEdge.out = t.x1;
    else if (t.text === "in" || /(?:^|\s|-)in$/.test(t.text)) headerEdge.in = t.x1;
    if (t.text === "Balance" || /Balance$/.test(t.text)) headerEdge.balance = t.x1;
  }

  if (headerEdge.out === undefined || headerEdge.in === undefined || headerEdge.balance === undefined) {
    return { anchors: {}, headerY };
  }

  const cols: Column[] = ["out", "in", "balance"];
  const byCol: Record<Column, number[]> = { out: [], in: [], balance: [] };
  for (const line of lines) {
    if (headerY !== null && line.y <= headerY) continue;
    for (const t of line.tokens) {
      if (!AMOUNT_RE.test(t.text) || t.x0 < MONEY_LEFT_FRAC * width) continue;
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
  const value = parseAmount(t.text);
  if (value === null || t.x0 < MONEY_LEFT_FRAC * width) return null;
  const cols = Object.keys(anchors) as Column[];
  if (!cols.length) return null;
  let best: Column = cols[0];
  for (const c of cols) {
    if (Math.abs(t.x1 - (anchors[c] as number)) < Math.abs(t.x1 - (anchors[best] as number))) best = c;
  }
  if (Math.abs(t.x1 - (anchors[best] as number)) > REJECT_DIST_FRAC * width) return null;
  return { col: best, value };
}

/**
 * Parse a BOI statement PDF into structured data, deterministically.
 */
export async function parseBoi(pdfBytes: Uint8Array): Promise<StatementData> {
  const pages = await extractPages(pdfBytes);
  const transactions: Transaction[] = [];

  let openingBalance: number | null = null; // first BALANCE FORWARD seen
  let closingBalance: number | null = null; // last printed balance / SUBTOTAL
  let running: number | null = null;        // reconstructed running balance
  let currentDate = "";
  let sawOpening = false;

  for (const { tokens, width } of pages) {
    const lines = groupLines(tokens);
    const { anchors, headerY } = detectAnchors(lines, width);
    const balEdge = anchors.balance ?? width;

    for (const line of lines) {
      if (headerY !== null && line.y <= headerY) continue;

      const joined = line.tokens.map((t) => t.text).join(" ");

      // SUBTOTAL = page-closing balance (and the next page's BALANCE FORWARD).
      // It's a checkpoint, not a transaction; the rest of the page is footer.
      if (joined.startsWith("SUBTOTAL")) {
        const amt = line.tokens.map((t) => parseAmount(t.text)).find((v) => v !== null);
        if (amt !== undefined && amt !== null) closingBalance = amt;
        break;
      }
      // Legal footer / page-number line → end of this page's table.
      if (joined.startsWith("Bank of Ireland") || joined.startsWith("Page ")) break;

      // Overdraft marker. Two tokenizations: a SEPARATE "OD" token to the right of
      // the balance, or pdfjs joining the amount + marker into one ("6.00 OD").
      const hasOD = line.tokens.some((t) => t.text === "OD" && t.x0 > balEdge - OD_MARGIN);
      let glueOdBalance: number | undefined; // balance from a glued "6.00 OD" token
      for (const t of line.tokens) {
        const m = OD_BALANCE_RE.exec(t.text);
        if (m && t.x0 > MONEY_LEFT_FRAC * width) {
          const v = parseAmount(m[1]);
          if (v !== null) glueOdBalance = -v;
        }
      }

      // Bucket tokens into date / description / money.
      const dateToks: Token[] = [];
      const descToks: Token[] = [];
      const moneyToks: Token[] = [];
      for (const t of line.tokens) {
        if (classifyAmount(t, anchors, width)) moneyToks.push(t);
        else if (t.text === "OD" && t.x0 > balEdge - OD_MARGIN) continue; // separate overdraft marker
        else if (OD_BALANCE_RE.test(t.text) && t.x0 > MONEY_LEFT_FRAC * width) continue; // glued "6.00 OD"
        else if (t.x0 < DATE_RIGHT_FRAC * width) dateToks.push(t);
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
      let balance = cols.balance;
      if (balance !== undefined && hasOD) balance = -balance; // overdrawn (separate OD)
      if (glueOdBalance !== undefined) balance = glueOdBalance; // overdrawn (glued "X.XX OD")

      // BALANCE FORWARD: page-opening balance / cross-page checkpoint.
      if (description.toUpperCase().startsWith("BALANCE FORWARD")) {
        if (balance !== undefined) {
          running = balance;
          if (!sawOpening) {
            openingBalance = balance;
            sawOpening = true;
          }
          // Also treat it as the latest known closing balance. In a normal
          // statement this is overwritten by the postings/SUBTOTAL that follow;
          // in a no-activity month (only BALANCE FORWARD, no transactions) it
          // stays, so closing == opening and the statement reconciles with 0 tx.
          closingBalance = balance;
        }
        continue;
      }

      const out = cols.out;
      const paidIn = cols.in;

      // A transaction is any line carrying a payment-out OR payment-in amount.
      if (out !== undefined || paidIn !== undefined) {
        const delta = (paidIn ?? 0) - (out ?? 0);
        if (running !== null) running = Math.round((running + delta) * 100) / 100;
        transactions.push({
          date: currentDate,
          description,
          debit: out ?? 0,
          credit: paidIn ?? 0,
          balance: running,
        });
      }

      // A printed balance is the latest known closing balance.
      if (balance !== undefined) closingBalance = balance;
    }
  }

  return {
    bank: "Bank of Ireland",
    openingBalance: openingBalance ?? 0,
    closingBalance: closingBalance ?? 0,
    transactions,
  };
}
