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
- **Data lives OUTSIDE git** (all gitignored): input PDFs in `statements/<bank>/…`,
  results in `.reconcile/` — `baseline.json` (accepted records), `snapshots/<key>.csv`
  (the accepted ROWS, human-readable), and `last-run.json` (latest run, overwritten —
  no timestamped history). Override the input root with `STATEMENTS_DIR` if needed.
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
- **Row-level diff on regression:** on any `CHANGED-CONTENT`/`CHANGED-RECON` the run prints
  the changed rows (`+`/`-`) vs the saved CSV snapshot, so you see WHAT moved, not just a
  hash flag. The snapshot is the accepted rows; it is refreshed under the same policy as
  the baseline (NEW / first-seen / `--update-baseline`), never on an unaccepted change. The
  full reusable CSVs live under `.reconcile/snapshots/` for opening/diffing by hand.
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
  per-statement summary/recap rows (a value in the opening-balance column). A single
  PDF may concatenate **several current-account periods**, each ending with a
  "Reverted" tail (no Balance column → its rows are skipped automatically), so do
  NOT stop at reverted — the next period re-syncs at its table header and chains by
  balance. **Hard-stop only at a SEPARATE-account sub-statement** (savings/deposits/
  pockets/vaults — `isSeparateAccountSection`), which carries its own balance series.

Per-bank status (specifics → `CLAUDE.md`):

- **Revolut** (`revolut-parser.ts`) — RO/EN/RU, EUR/RON/GBP, both number & date
  formats (incl. Cyrillic months), summary-row handling, multi-period PDFs (reverted
  tails skipped, periods chained by balance), and separate-account hard-stop
  (savings/deposits "Deposit transactions"/"Depuneri"/RU "Операции пополнения",
  pockets/vaults "Buzunare"/"Seifuri"/RU "сейф"/"кошельк", sub-accounts
  "contul pentru …"/"account for …"/RU "счету пользователя …"). The savings word is
  gated by font size so the everyday "Пополнение счета" top-up *transactions* don't
  match. **Glued description+amount tokens** (pdfjs emits an outgoing "Перевод SWIFT
  … 607,00€" as ONE item gluing description + amount in a money column) are split by
  `splitGluedAmount` so the amount is counted; a pure code-currency amount with no
  description (e.g. "168.99 RON") is left in place so summary rows still skip.
  Multi-currency bundles ("Extras EUR" + "Extras GBP" in one PDF) ARE handled —
  `parseRevolutAccounts` splits pages by header currency and `extractRevolut`
  reconciles each currency separately (per-account result, like consolidated).
  NOT handled: the Revolut CSV/Excel export rendered as PDF (single signed Amount
  column → no-tx; a distinct format).
- **Revolut consolidated / "Custom"** (`revolut-consolidated-parser.ts`) — a
  SEPARATE parser (bank `revolut-consolidated`): one PDF with many accounts and a
  different layout (signed amount column + Balance, no debit/credit). MVP = current
  accounts only (EN/RO/RU), each reconciled per-account and shown as its own
  detailed, separately-exportable (CSV) table; savings/crypto deferred. Recognizes
  BOTH personal and JOINT current accounts ("Cont comun"/"Joint Account"/"Совместный
  счет") — a user can hold both in one currency. A PDF with NO current-accounts
  section (savings/crypto-only or empty period) reports `currentAccountsSection:
  false` → `allReconciled: true` (nothing in scope), NOT a fail.
- **AIB** (`aib-parser.ts`) — per-page anchors detected from the header (columns
  scale with page width), glued `dr` overdraft, balance-forward per page.
- **BOI** (`boi-parser.ts`) — Payments-out / Payments-in columns, `OD` overdraft,
  subtotal checkpoints.
- **PTSB** — no deterministic parser yet (uses the AI + reconciliation fallback).

**Transaction provenance.** Every deterministic parser stamps each row with `page`
(1-based PDF page); `extractAndReconcileMany` stamps `sourceFile` when combining
several PDFs. The UI table + CSV show a **Source** column ("file.pdf, page 23") via
`transactionSource()`. The AI path leaves `page` unset (chunked pages) → file only.
These fields don't affect reconciliation or the harness fingerprint, so a new parser
must set `page` but it won't change the regression baseline.

**Multi-PDF combine.** `extractAndReconcileMany` merges several PDFs of one account.
**Ordering is CHRONOLOGICAL by each statement's transaction date range** (in
`combineStatements`), NOT by the balance chain — whole statements are sorted, rows
within a statement stay put (running balance intact). This matters because banks with
**sporadic balances** (AIB prints the balance only at block checkpoints, so many rows
carry 0) mis-chain when ordered closing→opening: the statements came out in file/alpha
order and the wrong endpoint got picked, so the account failed reconciliation. Sorting
by date fixed both order AND reconciliation (AIB 589 / AIB 662 were off-by, now pass).
**Gap detection runs on that chronological order**, with TWO triggers between consecutive
statements: (a) **balance break** — this closing ≠ next opening; OR (b) **date jump** —
the seam between one statement's period END (last tx) and the next's period START exceeds
an adaptive threshold (`max(0.5 × median statement span, GAP_MIN_DAYS=25)` days), i.e. ≈ a
whole period is missing. `fullyChained` = no gaps. Two reasons: (1) the OLD approach
re-derived order from the balance chain (segments) and produced FALSE gaps when a value
REPEATED as both an opening and a closing — AIB 589 both opens at 0 and later closes at 0,
so head-detection linked October's closing 0 to January's opening 0 and flagged a spurious
gap; chronological-adjacency removed those (AIB 589 now `fullyChained`). (2) A missing
statement that nets to ZERO is INVISIBLE to the balance chain (neighbours still chain
…0→0… and reconcile) — only the date jump reveals it. **CRITICAL: the seam uses each
statement's DECLARED opening date (`StatementData.openingDate` = the BALANCE FORWARD /
OPENING BALANCE row date, captured by the AIB/BOI parsers), NOT its first transaction** —
a statement can open then stay dormant for weeks. Real trap: AIB 662's Feb statement OPENS
22 Aug 2024 (balance 0) but its first posting is 2 Dec — a 116-day dormancy INSIDE one
statement, NOT a hole between statements (the Aug and Feb statements are contiguous, seam
14 days). Using the first transaction made this a FALSE gap; `openingDate` fixes it (AIB
662 is `fullyChained`, reconciles, nothing missing). A missing statement WITH movements
also breaks the balance chain AND fails reconciliation, so it's caught twice over.
(Residual: a statement dormant at its END could rarely false-positive — period end = last
tx — hence "possible"; future upgrade = also capture the declared closing date.)
Revolut/consolidated don't set `openingDate` → fall back to first tx. Duplicates are matched by
CONTENT (`contentKey` = opening/closing + every transaction), so the same statement
uploaded under a different name is caught; the copy is excluded and reported in
`duplicates[]`. Empty statements (0 tx) are never flagged as duplicates. The regression
harness (643) is unchanged by both switches (gaps/`fullyChained` aren't fingerprinted;
correctly-chained sequential statements already had date-order == chain-order).

**Categorization** (`categorization.ts`). A separate post-reconciliation step that sets
each transaction's `category` from a fixed list. Layer 1 = ordered keyword RULES (zero
AI, ~55% of rows on the test set), calibrated on real descriptions; Layer 2 = Gemini on
the UNIQUE remaining descriptions in parallel batches, applied back to all matching rows.
It runs only when the UI `categorize` toggle is on (in `app/api/extract/route.ts`), never
touches reconciliation, and is NOT in the pipeline/harness path. Adding a keyword rule:
edit `RULES` (order matters — first match wins; use `\b…\b` where a substring would
over-match). Toggling categorization off makes zero AI calls. Categories are editable
inline in the UI via a styled combobox (`app/category-combobox.tsx`, menu portalled to
`<body>` to escape the table's `overflow: hidden`): pick from the list OR type a custom
category; the change propagates to every row with the same normalized description
(`catOverrides`, client-side only) and flows into the CSV — purely informative, never
touches reconciliation.

**Per-column sort + filter (BACKLOG 1.3).** The main table's headers each open an
Excel-style dropdown (`app/column-filter.tsx`, portalled to `<body>`): sort asc/desc + a
type-specific filter (text contains, category checkboxes, a Year→Month→Day date tree, numeric
min/max).
**Manual verification tick (BACKLOG 2.1).** A "Check mode" toggle (off by default) reveals a
leading checkbox column on the main table to mark rows "verified" while checking against the PDF
(subtle green wash + a "X of Y verified" counter). State is a client-side `Set` of original row
indices (`verified`), session-only, purely visual — never touches data/categories/reconciliation;
ticks survive filtering/sorting.

Column filters combine with AND; one sort key at a time. Pure logic in `app/table-view.ts`
(`applyView`); `app/page.tsx` derives `displayRows` from `viewData.transactions` (filter +
sort a COPY, keeping each row's original index). PURELY presentational — reconciliation, the
verdict, the balance-break check and the CSV always use `viewData` in original order. "Clear
all filters" resets it; a discrepancy jump clears it first so the target row is visible.

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
- **Scanned / image-only PDFs → no text layer.** pdfjs extracts **0 text tokens**,
  so EVERY deterministic parser returns `no-tx` — this is NOT a parser bug, there's
  nothing to read positionally. Diagnose with a quick read-only pdfjs token count
  before touching a parser (e.g. `statements/BOI/2/*` are all scans). Scanned
  statements need the **AI vision path** (Gemini OCRs the image) + reconciliation;
  the deterministic harness correctly marks them `no-tx`.
- **Anti-extraction fonts (PTSB) → digits absent from the text layer.** `PTSB-combined.pdf`
  has a text layer, but the body uses the **"AllAndNone"** font whose ToUnicode is
  poisoned: verified **0 digit mappings out of 1315** ToUnicode targets (letters map,
  digits don't). Column X-positions and even descriptions are recoverable, but the
  **amounts cannot be read as text at all** — they exist only as drawn glyph shapes.
  So a deterministic parser is impossible without OCR/glyph-shape recognition; PTSB
  stays on the **AI vision path**. (Revisit a deterministic parser only with several
  PTSB samples AND if `fontkit` shows the embedded glyph *names* survived.)
- **AI fallback on empty.** In the app, when a parser returns 0 transactions the
  pipeline falls back to AI vision (`PipelineOptions.allowAiFallback`, default true).
  The harness passes `allowAiFallback: false` → it never makes AI calls and keeps
  unreadable layouts as a deterministic `no-tx`.
  - **Exception — valid empty statement.** 0 tx ≠ always unreadable. A dormant /
    no-activity month is a real statement with no postings. Before falling back, the
    pipeline returns the result as a **PASS** when it **reconciles** (opening ==
    closing) AND a **real balance was read** (`openingBalance !== 0 ||
    closingBalance !== 0`) — no AI call. The "balance ≠ 0" gate separates a genuine
    empty month (e.g. 383.35/383.35) from an unreadable PDF (parser finds nothing →
    0/0 → still falls back). In the harness, such a statement now shows **`pass`**
    (not `no-tx`); `no-tx` is reserved for 0 tx that did NOT reconcile.
- **Encrypted bank PDFs.** Some banks (notably **BOI**) export statements
  permission-encrypted with an EMPTY user password. **pdfjs decrypts them
  transparently**, so the deterministic parsers read them with no special handling.
  **pdf-lib cannot** (it refuses encrypted PDFs, and `ignoreEncryption:true` only
  skips the check — it does NOT decrypt the streams, so the chunks come out
  corrupt). pdf-lib is used ONLY on the AI path (`pdf.ts` splitting); there, an
  encrypted PDF now throws a clear, actionable error pointing the user to select the
  supported bank (deterministic reader). Net effect: encrypted statements of a
  supported bank just work via the deterministic parser; the AI path stays honest.
- **Test statements** live (gitignored) under `statements/<bank>/…` inside the repo
  — moved there from `D:\work\statements`. All Revolut RO/EN/RU + consolidated, and
  AIB/BOI current/business/saving statements reconcile — including AIB and BOI **loan**
  statements (all-overdraft balance chains; AIB loans open with "OPENING BALANCE"),
  BOI **no-activity months** (only BALANCE FORWARD → 0 tx, opening == closing →
  `pass`), and BOI **permission-encrypted** PDFs (pdfjs decrypts them).
  AIB credit-card layouts and scanned PDFs stay `no-tx` (no parser / no text layer).

---

## Multiple bank accounts (multi-account, BACKLOG 3.1)

One client with several accounts → upload them together, reconcile EACH on its own,
show ONE combined table with the account label as the first column. **Reduced scope
(confirmed): NO transfer detection, NO cross-account reconciliation.** (An earlier,
larger attempt with transfer matching + badges was reverted by the user.)

- **Module split (client/server).** `app/page.tsx` is `"use client"`, so anything it
  imports at runtime lands in the browser bundle. Keep the pure helpers
  (`dedupeLabels`, `mergeAccounts`) in **`lib/core/multi-account.ts`** — it imports ONLY
  `type`s (erased), never `pipeline.ts`/pdfjs/gemini. The orchestration
  (`extractAccounts`) lives in **`lib/core/multi-account-extract.ts`** and is imported
  ONLY by the API route. Breaking this pulls the pdfjs worker + Gemini into the client
  bundle.
- **Dispatch** (`extractAccounts`): per account — `revolut-consolidated` →
  `extractConsolidated`; single-file `revolut` → `extractRevolut` (a multi-currency
  bundle splits into one logical account per currency); N files → `extractAndReconcileMany`
  (chaining + gaps + duplicates); else → `extractAndReconcile`. Each account runs in
  `Promise.all`, wrapped so a failure re-throws with the label prefixed. Labels are
  deduped AFTER the currency split. `sourceFile` is backfilled on single-file accounts.
- **Merge** (`mergeAccounts`, client-side): interleave all rows by ISO date (stable;
  ties by account order then row order), stamping each with `accountLabel`. The combined
  table reuses the existing single-table stack by pointing `transactions` at these rows;
  the merged index IS the row's "original index" (ids/highlights/category-cell/check-mode
  stay tied to it). `viewData`/`r`/balance-breaks stay on the single path (null in multi).
- **Hidden in multi mode**: the standard verdict/equation, financial-period bar,
  balance-breaks + "Next discrepancy", and the dev trace/corrections (all per-extraction).
  The verdict comes from the per-account summary; `allReconciled` = every account with
  transactions reconciles.
- **API**: `accounts` JSON `[{bank, label}]` + files under repeated `account-<i>` keys
  (caps: 8 accounts / 60 files total / 40-char labels), backward-compatible with
  `file`/`files`. Returns `{ multi: { accounts, allReconciled }, fileName, categorization }`.
- **CSV**: `toCsv` prepends an "Account" column ONLY when a row carries `accountLabel`
  (combined export). Per-account CSVs and every existing single/harness CSV are unchanged
  (byte-identical) because their rows have no `accountLabel`. `Transaction.accountLabel`
  is display-only and NOT part of the reconciliation fingerprint.
- **Test**: `npm run test:multi` — synthetic asserts (dedupe, merge order + stamping) +
  real clients under `statements/interbank/<n>/`. **Each numbered folder = ONE separate
  client; never mix folders.** Runs with `allowAiFallback: false` (deterministic, no API).
  Deferred (named, not built): transfer detection; per-account balance-breaks in the
  combined table; period-bar in multi; cross-account duplicate warning.

## Status snapshot (update as it changes)

- **Revolut**: production-ready across RO/EN, EUR/RON, both number/date formats;
  summary-row and savings-section handling; crypto "soft" verdict.
- **AIB / BOI**: deterministic parsers exist (see `CLAUDE.md`). **PTSB**: no
  deterministic parser yet (uses AI + reconciliation).
- **Multi-account** (one client, several banks): combined table + per-account
  reconciliation shipped; NO transfer detection (out of scope). See section above.
- Next candidates: PTSB parser; automatic bank identification; DB/auth (Phasing).
