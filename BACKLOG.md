# Product Backlog

Bank statement extraction + reconciliation application. Items are grouped by
priority. Within each phase, order reflects dependencies (build top to bottom).

Legend:

- **Effort:** S (small) / M (medium) / L (large)
- **Value:** ★ to ★★★
- **Type:** UI flow / Reconciliation / Completeness / PDF tooling / Nice-to-have

---

## ✅ Already built (baseline)

- Deterministic parsers for AIB, BOI, Revolut (RO/EN/RU) — 100% accurate, fast.
- Universal reconciliation (opening + credits − debits = closing, ±2 cents).
- Balance-based sign correction (debit/credit auto-fix).
- Multi-PDF upload + chaining by balance + gap detection.
- AI fallback (Gemini) for non-target banks, with model cascade.
- CSV export, running-balance row check, reconciliation verdict UI.
- Deployed and working online.

---

## PHASE 1 — Manager's priority (build now, in this order)

These depend on each other: categorization first, then editing categories,
then filtering. Build top to bottom.

### 1.1 — Automatic transaction categorization

- **Type:** UI flow + AI · **Effort:** M · **Value:** ★★★
- Send extracted transactions to Gemini; it assigns each one a category based on
  the description.
- **One `category` column** (not category + subcategory — see decision note).
- Fixed category list (AI must choose ONLY from it; includes "Other" fallback).
- **Efficiency:** categorize only UNIQUE descriptions, then apply back to all
  matching rows (e.g. "Tesco" categorized once, not 50×). Cuts AI cost/time ~10×.
- **Parallel batches** (like page parallelization) so it stays under the 60s limit.
- New module `lib/core/categorization.ts`; add `category?: string` to the
  `Transaction` type (optional, so nothing existing breaks).
- New `category` column in the table and in the CSV export.
- Toggle in UI (categorization on/off) to control AI cost.

### 1.2 — Edit categories + auto-propagation

- **Type:** UI flow · **Effort:** M · **Value:** ★★★
- User can edit a transaction's category inline.
- **When a category is edited, all transactions with the SAME description update
  automatically.** (Propagate on identical/normalized merchant name, NOT on
  "contains" — avoids "Tesco" vs "Tesco Mobile" being lumped together.)
- Editing is informative only — does not affect reconciliation (categories are
  labels, not amounts).

### 1.3 — Filtering (date, alphabetical, by category)

- **Type:** UI flow · **Effort:** S · **Value:** ★★
- Filter/sort the transactions table by date, alphabetically (description), and
  by category.
- Comes naturally after categories exist (you'll want to filter by category too).

---

## PHASE 2 — Quick wins (after Phase 1 works)

### 2.1 — Manual review mode + discrepancy check (combined)

- **Type:** UI flow · **Effort:** S–M · **Value:** ★★★
- A single visual-verification system:
  - Tick / color cells or rows while manually checking extracted transactions.
  - When reconciliation flags a discrepancy, the user can jump to that row,
    verify it, and mark it "checked / OK" or "not OK".
- **Why it matters:** reconciliation can throw a false positive (a rounding, a
  slightly misread amount). The user must be able to say "I verified this, it's
  fine" so a minor discrepancy doesn't block them.
- Combine "manual mode" and "discrepancy check" into one checked/OK-state system.
- State is per-row (checked, ok/not-ok, optional color).

### 2.2 — Full inline editing (amounts, descriptions)

- **Type:** UI flow · **Effort:** M · **Value:** ★★
- Extend editing beyond categories to amounts/descriptions.
- **Reconciliation recalculates automatically after an edit** (the verdict updates).
- Clarify behavior: editing an amount re-runs the running-balance check.

---

## PHASE 3 — Differentiators (after the base is solid)

These are the features generic tools don't have — real competitive edge.

### 3.1 — Inter-bank reconciliation (internal transfers)

- **Type:** Reconciliation · **Effort:** M · **Value:** ★★★
- A client with several accounts: load all statements; the app finds transfers
  BETWEEN the client's own accounts (a debit in one = a credit in another).
- These aren't real income/expense, just internal movements — flagging them is
  very valuable for an accountant.
- Logic: match equal-and-opposite amounts across accounts at close dates.

### 3.2 — Reconciliation against expenses (Excel)

- **Type:** Reconciliation · **Effort:** M · **Value:** ★★★
- Upload an Excel of expenses; the app finds which ones were actually paid from
  the bank account (match on amount + date + optionally description).
- Answers a real question: "which invoices/expenses were actually paid?"
- (User marked this nice-to-have, but it's a strong differentiator.)

### 3.3 — Period completeness check

- **Type:** Completeness · **Effort:** S · **Value:** ★★★
- "Doing the 2025 year-end — is the year complete?" Load all statements; the app
  says whether the period is fully covered or a statement is missing.
- **Partly built already:** `combine.ts` detects gaps in the balance chain.
  Extend it to verify coverage over a date range (e.g. all of 2025).

---

## PHASE 4 — Specialized / later

### 4.1 — RCT / Employment Summary reconciliation (Irish-specific)

- **Type:** Reconciliation · **Effort:** L · **Value:** ★★★ (for Irish market)
- Upload RCT made/received and Employment Summary documents; the app finds the
  relevant transfers by name, by date, or by amount.
- Highly valuable for the Irish market (a niche generic tools don't serve), but
  the most complex (varied document formats, fuzzy name matching).
- Do after the simpler reconciliation types are validated.

### 4.2 — Combine PDFs into one sorted PDF

- **Type:** PDF tooling · **Effort:** S–M · **Value:** ★★
- Upload all statements; the app sorts them correctly and merges them into a
  single PDF.
- Note: this is PDF manipulation (physical merge), separate from the extraction/
  reconciliation engine. Nice-to-have.

### 4.3 — Anomaly flagging (NOT "fraud detection")

- **Type:** Nice-to-have · **Effort:** M · **Value:** ★ (and risky)
- **Important caution:** do NOT build "fraud detection" / money-laundering
  labelling. Legal/professional risk if it wrongly flags (or misses) a client,
  and a single pattern (salary-in + large ATM-out) yields many false positives.
- IF ever built: frame as NEUTRAL anomaly flagging for the accountant's
  attention ("account shows only salary inflows and large ATM withdrawals —
  review"), never an accusation. In the spirit of "flag, don't auto-correct."
- Defer; possibly never as "fraud detection."

---

## Key decisions (recorded)

- **Category vs subcategory → ONE `category` column.** Reasons: more reliable for
  the AI, simpler to edit/propagate/filter, enough for an informative label. Use
  a fixed list of sufficiently specific categories (e.g. "Fuel", "Public
  Transport", "Taxi" directly — not Transport→Fuel). Add `subcategory` ONLY if a
  real need for hierarchical reporting appears later (it's then one extra column,
  not a rewrite).

- **Propagation matches on identical/normalized description**, not "contains".

- **Categorization is informative** — never affects reconciliation amounts.

- **Fraud detection deferred / reframed** as neutral anomaly flagging, much later.

---

## Suggested starting category list (tune to your practice)

For business / self-employed bank transactions:

Income · Transfers (internal) · Groceries · Dining · Fuel · Transport · Travel ·
Utilities · Rent/Premises · Office/Supplies · Professional Services · Insurance ·
Healthcare · Taxes/Government · Bank Fees · Subscriptions · Shopping · Cash/ATM ·
Other

(Cash/ATM, Transfers, Taxes/Government, Professional Services are especially
useful for accounting. "Other" is the safety net.)
