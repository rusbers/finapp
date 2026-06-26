# Working guide

> Practical playbook for working on this repo — written so a **new Claude Code
> session (or contributor) can pick up and work the same way** that produced the
> current parser/reconciliation quality. Read this together with `CLAUDE.md`
> (which has the product context and architecture); this file is the *how we work*
> and the *bank-parser reference*.

---

## RULE 0 — keep the docs up to date

**Whenever you change behavior (parsers, reconciliation, pipeline, UI, config),
update `CLAUDE.md` and this `WORKFLOW.md` in the SAME change.** Treat docs drift as
a bug. If you discover a new statement quirk or a gotcha, write it down here so the
next session doesn't rediscover it.

---

## How to work here (replicate this in any new session)

- **Small, supervised steps.** One focused change at a time. Show the diff and a
  one-line *what / why* before applying. Run `npm run build` after each change and
  keep it green.
- **After a parser change, OFFER the regression harness.** Whenever you create or
  modify a parser, ask whether to run `npm run test:statements -- <bank>` and report
  the diff vs the saved baseline BEFORE committing (see "Regression harness" below).
- **Language.** The founder writes in **Romanian**; all code, comments, UI copy,
  and docs stay in **English**. UI strings are centralized in `lib/strings.ts`.
- **Diagnose from the real data before coding.** For any extraction/reconciliation
  bug, look at the actual PDF token positions first (see the diagnostic recipe),
  then propose a fix. Don't guess at causes.
- **Reconciliation is the ground truth, never a box to tick.** Do NOT back-compute
  amounts from the running balance just to make it pass — that would mask real
  extraction errors, and catching those errors is the whole product. Extract
  faithfully; let reconciliation flag.
- **Flag, don't auto-correct.** Where the *bank's own* numbers are inconsistent
  (e.g. crypto spreads), keep the faithful extraction and surface it clearly (see
  the "soft" verdict) instead of silently adjusting amounts.
- **Validate against real statements AND the bank's own CSV export.** Match
  transaction count, opening/closing, and Σcredits/Σdebits to the cent. Caution: a
  bank CSV may merge multiple accounts (e.g. current + savings) into one file —
  compare against the correct series, not the merged total.
- **Money in integer cents**, reconciliation tolerance ±2 cents (see `CLAUDE.md`).

---

## Deterministic parser methodology

The per-bank parsers (`lib/core/*-parser.ts`) read the PDF's text with exact x/y
positions (via pdfjs) and map each token to a column by its **X anchor**. This is
100% reproducible, unlike AI extraction. To fix or add a parser:

1. **Dump token positions** for the failing page(s): for each line print `x0`,
   `x1`, font `size`, and the text; group tokens into lines by Y (tol ≈3pt);
   classify main rows (size ≥7) vs sub-rows (size ≈4.5).
2. **Compare the printed column-header X positions** to the parser's anchors —
   columns can shift by template / locale / page width.
3. **Run the reconcile replica** and `findBalanceBreaks` to see exactly which rows
   break and by how much (the deltas usually point straight at the cause).
4. Fix → `npm run build` → re-dump/re-reconcile → confirm against the bank CSV.

### Diagnostic scripts (temporary — recreate when needed, delete after; don't commit)

Throwaway Node ESM scripts kept in the **repo root** (so `import "pdfjs-dist"`
resolves against `node_modules`). They mirror `lib/core/pdf-loader.ts`: install a
minimal `DOMMatrix` polyfill, `import("pdfjs-dist/legacy/build/pdf.mjs")` + the
worker as a side-effect, then `getDocument({ data, disableWorker: true,
disableFontFace: true, isEvalSupported: false })`.

- `diag-revolut.mjs` — replays the Revolut parser logic and prints
  opening/closing, Σcredits/Σdebits, PASS/FAIL, and balance breaks. **Keep it in
  sync with `revolut-parser.ts`** (it has its own copy of the column logic; if they
  drift, the diag lies).
- `diag-rows.mjs` — full token dump for a page range: `node diag-rows.mjs <pdf>
  <fromPage> <toPage>`.
- `csv-check.mjs` — quote-aware CSV parser that totals a Revolut CSV export
  (FINALIZAT rows: count, Σ in/out, first/last balance) for cross-checking.

These are for **positional debugging of one statement**. For *regression* checking
across the whole corpus, use the harness below (don't hand-roll throwaway loops).

---

## Regression harness (`npm run test:statements`)

A permanent harness that runs every real statement through the SAME code path the app
uses and compares the result to the last accepted snapshot, so a parser change that
breaks a previously-good statement is caught immediately.

- **Runner:** `scripts/test-statements.mts` (run via `tsx`). It reuses production code —
  `extractAndReconcile` / `extractConsolidated` (`lib/core/pipeline.ts`) +
  `findBalanceBreaks`/`isExplainedByCryptoFees` (`lib/core/verification.ts`) — so it can
  never drift from the app (unlike the diag replicas above).
- **Scope:** deterministic parsers only (`revolut`, `revolut-consolidated`, `aib`, `boi`).
  AI banks (PTSB/Other) are excluded — non-deterministic + cost API. Add a bank by adding
  one entry to the `BANKS` array in the runner.
- **Data lives OUTSIDE git** (both gitignored): input PDFs in `statements/<bank>/…`,
  results in `.reconcile/` (`baseline.json` + a timestamped `runs/<ts>.json` log per run).
  Override the input root with `STATEMENTS_DIR` if needed.
- **Commands:**
  - `npm run test:statements` — all banks · `-- <bank>` — just one (the changed parser's).
  - `-- --update-baseline` — accept the current result as the new reference.
  - `-- --open` — also open the HTML report in the browser when the run finishes.
- **HTML report (the UI):** every run writes a self-contained `.reconcile/report.html`
  (generated by `scripts/report.ts`) — colour-coded status badges, summary cards, and
  client-side filtering (by status/bank + path search); consolidated shows per-account
  chips, and a CHANGED-RECON row is highlighted. Open it via the `file://` link the run
  prints, `npm run test:report`, or the `--open` flag. It's a dev/local artifact only
  (gitignored; nothing in `app/`, never shipped to production).
- **Per-statement status:** `pass | soft | fail | no-tx | error` (consolidated reports
  per account). **Diff vs baseline:** `NEW` · `UNCHANGED` · `CHANGED-CONTENT` (extraction
  differs but still reconciles — informational) · `CHANGED-RECON` (reconciliation outcome
  changed — the regression signal) · `MISSING`.
- **Baseline policy:** NEW statements are recorded automatically (first time seen = the
  reference). CHANGED / MISSING are only written with `--update-baseline`, so a real change
  is a conscious decision. Exit code is non-zero on any `CHANGED-RECON`, `MISSING`, or
  `error`.
- **Workflow:** after a parser change, run `-- <bank>`, eyeball the diff; if every change
  is intended, re-run with `--update-baseline` to lock it in, then commit.

---

## Per-bank parsers (general)

All deterministic parsers (`lib/core/*-parser.ts`) share the same shape. These
rules apply to **every** bank; each bank's exact column anchors and quirks are
documented per-bank in `CLAUDE.md` (keep them there, balanced across banks).

- **Map tokens to columns by X anchor** (Date / Description / Money out / Money in
  / Balance). Anchors are per-bank; some banks' columns scale with page width, so
  detect anchors from the header row rather than hardcoding (see AIB/BOI).
- **Main vs sub rows by font size** — amounts come only from main rows; sub-rows
  (fees, FX rate, references) are skipped.
- **Amounts** — `parseAmount` handles both number formats (English `1,234.56` and
  European `1.234,56`; rightmost separator = decimal). Money tokens are recognized
  by a currency symbol (€/$/£) or a 3-letter code suffix (e.g. `RON`).
- **Dates** — `toIsoDate` accepts day-first and month-first orders.
- **Start / skip / stop** — begin after the transaction-table header; skip
  per-statement summary/recap rows (a value in the opening-balance column); stop at
  non-transaction sections (reverted/refunded tails, savings sub-statements).

Per-bank status (specifics → `CLAUDE.md`):

- **Revolut** (`revolut-parser.ts`) — RO/EN/RU, EUR/RON/GBP, both number & date
  formats (incl. Cyrillic months), summary-row + savings/vault-section handling
  ("Depuneri de la" / "Операции по … сейфам"), multi-statement PDFs.
- **Revolut consolidated / "Custom"** (`revolut-consolidated-parser.ts`) — a
  SEPARATE parser (bank `revolut-consolidated`): one PDF with many accounts and a
  different layout (signed amount column + Balance, no debit/credit). MVP = current
  accounts only (EN/RO/RU), each reconciled per-account and shown as its own
  detailed, separately-exportable (CSV) table; savings/crypto deferred.
- **AIB** (`aib-parser.ts`) — per-page anchors detected from the header (columns
  scale with page width), glued `dr` overdraft, balance-forward per page.
- **BOI** (`boi-parser.ts`) — Payments-out / Payments-in columns, `OD` overdraft,
  subtotal checkpoints.
- **PTSB** — no deterministic parser yet (uses the AI + reconciliation fallback).

When adding a bank, follow the rules above and record its anchors/quirks in
`CLAUDE.md`.

### Bank-side inconsistencies → "soft" verdict (general)
Sometimes a **bank's own** printed figures don't add up (the running balance
differs from the printed money in/out) through no extraction error. Keep the
faithful extraction; detect the case and let the UI show a softer "explained"
verdict instead of a hard failure — never auto-correct amounts. Current example:
`isExplainedByCryptoFees` in `lib/core/verification.ts` (Revolut crypto-sell
spreads, where the gross crypto value is shown but only the net hits the balance).

---

## Gotchas

- **IDE-open files get clobbered.** If a source file (e.g. `revolut-parser.ts`) is
  open in the editor, the editor's stale buffer (and its on-save linter, which
  strips semicolons here) can overwrite edits made on disk. After editing such a
  file, **reload it from disk in the editor (Revert File)** before re-testing. This
  bit us repeatedly — if a fix "didn't take", check the on-disk file first.
- **pdfjs on serverless** — see `CLAUDE.md`: lazy load via `pdf-loader.ts`,
  `DOMMatrix` polyfill, worker imported as a side-effect, `disableWorker: true`,
  pass a **copy** of the bytes (pdfjs detaches them), `serverExternalPackages` in
  `next.config.ts`.
- **Test statements** live on the founder's machine under
  `D:\work\statements\Revolut\{ro,en}\…` (not in the repo). As of this writing all
  RO statements reconcile; EN (incl. a RON account, and a crypto account that hits
  the "soft" state) are validated.

---

## Status snapshot (update as it changes)

- **Revolut**: production-ready across RO/EN, EUR/RON, both number/date formats;
  summary-row and savings-section handling; crypto "soft" verdict.
- **AIB / BOI**: deterministic parsers exist (see `CLAUDE.md`). **PTSB**: no
  deterministic parser yet (uses AI + reconciliation).
- Next candidates: PTSB parser; automatic bank identification; DB/auth (Phasing).
