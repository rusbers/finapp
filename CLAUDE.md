# Project context

> This file gives Claude Code the context for this project. The application does
> not have a final name yet — it is referred to as "the application" / "the app"
> throughout. Replace with the real name once chosen.

---

## What the application is

A web application that automatically extracts transactions from **bank statements
(PDF)** and turns them into structured data (CSV, Excel, accounting formats),
**verifying the correctness of every statement through automatic reconciliation**.

The core differentiator is NOT plain PDF→CSV conversion — many tools already do
that. It is the **correctness guarantee through reconciliation**: for each
document, the app mathematically confirms that the extraction is complete and
correct, and where it does not add up, it flags the exact discrepancy.

The application is being built by an accountant, which provides a rare advantage:
deep understanding of the real need (verifiable correctness, not a marketing
accuracy percentage) and direct access to first customers. It will first launch
as an **internal tool** inside the founder's own accounting firm, tested on real
clients, before any commercialization.

---

## The problem

Accountants, accounting firms, lenders, and auditors process large volumes of
bank statements. Manual data entry is slow, costly, and error-prone. Existing
tools convert PDFs into tables but:

- give no clear guarantee that the extraction is **complete** (a missing
  transaction goes unnoticed);
- are mostly oriented toward US/UK banks, with poor coverage of European formats,
  pan-European neobanks, and local particularities (date formats, decimal
  separators, non-euro currencies);
- emphasize a declared accuracy ("99.9%") rather than the mechanism that actually
  matters to an accountant: verifying that the totals add up.

For an accountant, a single wrong amount or missing transaction means redoing the
manual check of the whole document — exactly the work the tool should remove.

---

## The solution

An engine that combines:

1. **Flexible AI extraction** (a vision model) that normalizes any statement
   layout into a single schema: `date | description | debit | credit`, plus the
   opening and closing balances.
2. **Universal reconciliation** as the correctness gatekeeper: for _every_
   document it checks `openingBalance + Σ credits − Σ debits = closingBalance`.
   Reconciliation does NOT depend on the bank — it is a single mathematical rule,
   valid for any statement in the world.
3. **Flagging, not auto-correction**: documents/transactions where reconciliation
   does not match are clearly flagged, with the discrepancy and the page noted.
   The user decides and corrects — responsibility stays with the user, and the
   product stays scalable (we do not sell hours of labor).

Reconciliation also acts as an **automatic test of the extraction**: if the
totals match, the extraction is almost certainly correct and complete, regardless
of the bank. This is what allows the honest claim "works with any bank" — not via
a template for each one, but via a universal check that confirms success.

### Crucial distinction: extraction vs reconciliation

- **Reconciliation is universal** — one rule for all banks. Simple arithmetic.
- **Extraction is the hard, variable part** — every bank's PDF looks different
  (debit/credit in separate columns vs one signed column; differently labeled
  balances; descriptions spanning multiple lines; varying date formats). The AI
  model handles this variability by normalizing any layout to the common schema.

---

## Target market

- **Primary:** independent accountants and small-to-mid accounting firms in the EU.
- **Secondary:** lenders (income verification), auditors, forensic accounting.
- **B2B/API channel:** firms with internal systems (CRM, ERP) that want
  reconciliation integrated into their own flow, without opening a separate app.

**Beachhead (practical start):** pan-European neobanks (Revolut, N26, Wise) — one
format covers customers across dozens of countries — plus the known banks from
the founder's own network. Market message: pan-EU. Execution: initially focused
where there is an advantage, then expanded based on real demand.

The market message is general (not tied to one country, not sold on "data
sovereignty"). The application should also serve customers outside the EU (e.g.
US) if they want it.

---

## Tech stack and architecture

Unified JavaScript/TypeScript stack, built incrementally, modular and
correctable (not "perfect" up front).

- **Landing page** (`<domain>`): Astro + a Git-based CMS (content in Markdown).
  Lightweight, fast, excellent SEO. Separate project. _(Not built yet.)_
- **Application** (`app.<domain>`): Next.js (React for the UI + server logic in
  the same project). This is where the extraction engine, reconciliation, and
  endpoints live.
- **Database:** PostgreSQL (via Supabase or Neon). _(Not added yet.)_
- **Authentication:** an off-the-shelf solution (Clerk or Supabase Auth) — do not
  build login from scratch. _(Not added yet.)_
- **AI:** Gemini (Flash model for cost/speed; a stronger model as a fallback when
  reconciliation fails). Provider-agnostic code so it can be switched.
- **Payments:** Stripe. _(Later.)_
- **Mobile (future):** React Native, consuming the same endpoints — no logic
  rewrite. Likely a secondary use case; web is the primary product.

### Architectural principles

- **Separation of concerns:** the server logic (the "brain": extraction,
  reconciliation, templates, accounts) is separate from any UI. The web app, a
  future public API, and future mobile all consume the **same endpoints**. The
  logic is never duplicated and never lives in the browser.
- **Secrets stay on the server.** The AI API key is only ever used server-side,
  never shipped to the browser.
- **Provider-agnostic AI.** Switching from Gemini to another provider should mean
  adding one function and changing one call — not a rewrite.
- **Integer cents everywhere** for money. Never floating-point decimals — they
  cause false reconciliation failures (e.g. 0.1 + 0.2). Reconciliation tolerance
  is ±2 cents.

### Speed strategy (build toward, not all at once)

Speed comes from architecture, not from the language:

- parallelize pages/files (process many at once);
- use the Flash model, not the flagship;
- skip the AI entirely for native (text) PDFs — extract text directly;
- later, templates for known banks → no AI call → sub-second;
- live progress feedback in the UI (perceived speed).

---

## Development approach (important)

Build **layer by layer**, validating each layer before adding the next. Do NOT
build the whole "enterprise" machine at once — that is the most common way good
projects fail. The target is **clean and modular**, not "perfect up front."
Modularity makes wrong decisions cheap to correct later.

The founder acts as a **supervisor** (has medium frontend knowledge, codes via
Claude Code rather than by hand). Therefore: build in **small, verifiable steps**,
keep each piece modular and self-contained, and explain non-obvious code. Avoid
generating large tangled chunks that are hard to supervise.

### Things to explicitly NOT do prematurely

- **No i18n yet.** UI copy is centralized in `lib/strings.ts` (English only) so
  i18n is easy later, but do not install i18n libraries or build locale
  structures until the market asks for it.
- **No bank-specific templates yet.** The template + auto-repair + versioning
  system is the long-term destination, but for now extraction runs the AI on
  every statement + reconciliation (with the flash→pro cascade). Add templates
  later, once the base engine is proven and there is data on which banks dominate.
- **No enterprise features (teams, API plans, SOC 2) yet.** Add when justified.

Note: the model **cascade** (primary → fallback on reconciliation failure) IS now
implemented in `pipeline.ts`. Models and fallback on/off are selectable from the
UI per request, with defaults in `config.ts` (lite / pro / off). Keep fallback on
for testing; off by default in production to control cost.

### Templates (future design, for reference)

When added: identify the bank cheaply (from IBAN/text), apply a saved template
(rules/config, NOT auto-generated executable code) without an AI call. If
reconciliation fails **repeatedly** on a known bank (not on a single bad PDF), the
bank likely changed its format → call the AI to regenerate the template → save a
new version (keep old versions too, since multiple formats circulate). A single
reconciliation failure just flags the statement to the user; it does not trigger
regeneration.

---

## Phasing

1. **Feasibility test.** 20-30 real (anonymized) statements from target banks, run
   through the engine, measuring how many pass reconciliation and where the model
   errs. Cheap; decides whether the idea works technically before any investment.
2. **Internal tool.** Used inside the founder's firm on real clients. Validates
   usefulness, gathers data on dominant banks and problem areas, produces internal
   proof.
3. **Commercial MVP.** After internal validation: polished UI, accounts, pricing,
   first external customers from the network.
4. **Expansion.** More banks (data-driven), integrations, API plan, possibly
   mobile — layer by layer, driven by real demand.

Key advantage: even if it never becomes a commercial product, it remains an
internal tool that saves hours — so the investment cannot be "lost."

---

## Pricing model (orientation, to be calibrated)

Monthly subscription in **tiers with included pages** (predictable for the
customer, protected margin for the business). Indicative tiers: ~€25 (~300
pages), ~€70 (~1,500), ~€180 (~5,000), ~€350 (~8,000-10,000). Over-cap → upgrade
prompt or small per-page overage. Avoid an "unlimited" plan until real costs are
known. A separate **API plan** later, as a premium product for integrations.

Rule: charged price per page must comfortably cover real cost per page × ~3 (AI +
retries + infrastructure + margin). AI cost with the Flash model is a tiny
fraction of revenue.

---

## Compliance (GDPR)

A legal obligation when processing EU clients' data, whether or not it is promoted
as a selling point. Needed: a signed **DPA** with the AI provider (and other
subprocessors) — accepted once at the company level, not by end users; a legal
transfer mechanism for data leaving the EU where applicable; disable training on
customer data at the AI provider; a clear privacy policy + terms of use accepted
by users; respect for user rights (access, deletion) and adequate security
(encryption). Heavy certifications (e.g. SOC 2) are deferred until selling to
large clients. A data-protection lawyer review at launch is recommended.

---

## Current state (what exists)

The core is built and working end to end: an upload page + a backend endpoint
that runs the extraction cascade, reconciliation, and per-model stats.

### Folder structure (fixed up front)

The business logic (`lib/core/`) is separated from the framework (`app/`). The
core is framework-agnostic and reusable by the web app, a future public API, and
future mobile. The endpoint is a thin layer that just wires core logic to HTTP.

```
app/
├── api/extract/route.ts   → POST /api/extract — thin endpoint, calls the pipeline
├── page.tsx               → upload page + manual verification (UI)
├── layout.tsx             → root layout
└── globals.css            → styles
lib/
├── core/                  → business logic (framework-agnostic, reusable)
│   ├── types.ts           → shared domain types (single source of truth)
│   ├── config.ts          → pipeline defaults (model names, fallback) + model allow-list
│   ├── reconciliation.ts  → reconciliation logic (pure, tested)
│   ├── gemini.ts          → Gemini provider: API call, retries, JSON repair (server-only)
│   ├── prompts.ts         → per-bank prompt registry (base + bank-specific rules)
│   ├── revolut-parser.ts  → DETERMINISTIC Revolut parser (pdfjs text positions; 100%)
│   ├── aib-parser.ts      → DETERMINISTIC AIB parser (pdfjs; right-aligned cols, scales w/ width)
│   ├── boi-parser.ts      → DETERMINISTIC BOI parser (pdfjs; Payments-out/in cols, OD overdraft)
│   ├── parsers.ts         → registry mapping banks → deterministic parsers
│   ├── combine.ts         → chains multiple statements by balance, detects gaps
│   ├── pdf.ts             → PDF splitting into page-chunks (pdf-lib, server-only)
│   ├── extraction.ts      → split + parallel extract + merge (provider seam)
│   ├── pipeline.ts        → extract-and-reconcile cascade + per-model stats
│   ├── sign-correction.ts → balance-based debit/credit auto-correction
│   └── verification.ts    → CSV export + row-by-row running-balance check
└── strings.ts             → all UI copy in one place (ready for future i18n)
```

**Where things go as the app grows:**

- New AI providers → siblings of `gemini.ts` in `lib/core/`, selected in `extraction.ts`.
- Bank templates, categorization, anomaly detection → new modules in `lib/core/`.
- Database / auth / server-only services → a new `lib/server/` folder.
- New endpoints (export, accounts, public API) → new folders under `app/api/`.
- New UI screens → new routes under `app/`.

Keep the endpoint thin: HTTP wiring in `app/api/`, real logic in `lib/core/`.

### What's implemented

- **Extraction** via Gemini (PDF sent natively as base64), prompt enforces the
  schema, debit/credit rules, decimal-dot, dates, running balance, and EXACT
  statement order (no reordering).
- **Page parallelization** (`pdf.ts` + `extraction.ts`): large statements are
  split into small page-chunks (PAGES_PER_CHUNK, default 3), extracted IN
  PARALLEL (MAX_CONCURRENT_CHUNKS, default 8), then merged. This keeps each AI
  call small/fast and under the serverless time limit. The client uploads one
  file and never sees the chunking. Merge takes opening balance from the first
  chunk (page 1), closing from the last chunk, concatenates transactions in
  order, and falls back to the running balance to derive opening/closing if a
  chunk doesn't report them. **Requires the `pdf-lib` dependency** (`npm install
pdf-lib`).
- **Reconciliation** in integer cents, tolerance ±2 cents.
- **Balance-based sign correction** (`sign-correction.ts`): a recurring model
  error is putting an amount in the wrong column (debit shown as credit, or vice
  versa). When the statement has a running balance, the pipeline auto-corrects
  the direction from the math (balance down = debit, up = credit), BUT only when
  certain: both adjacent balances exist AND the balance change matches the
  amount. Corrections are applied before reconciliation and reported to the UI
  for transparency. Verified across the test set (Revolut, ING, BOI, PTSB all
  showed this error pattern).
- **Deterministic per-bank parsers** (`revolut-parser.ts`, needs `npm install
pdfjs-dist`): for the target banks, reading the PDF's text positions (x/y) and
  mapping values to columns by their X anchor is 100% accurate and consistent —
  unlike general AI extraction, which is unstable on dense multi-currency
  statements. This mirrors how DocuClipper reaches 100%. The Revolut parser is
  proven on a real 40-page statement (739 transactions, reconciles to the cent).
  Revolut column grid (PDF points): Date x0≈43, Description x0≈125, money-out/
  debit x0≈335 (left-aligned), money-in/credit x0≈417 (left-aligned), balance
  x1≈556 (right-aligned), tolerance ±6. Main transaction rows are font size ≥7;
  sub-rows (fee/FX-rate/reference, size≈4.5) are skipped so amounts come only
  from the main row. Only €/$ tokens count, so foreign-currency figures (e.g.
  "72.00 MDL") are ignored. Extraction starts after the transaction-table header
  ("Dată Descriere Sume retrase ... Sold" — the "Descriere" check avoids matching
  the balance-summary header) and stops at the "Înapoiate"/"Reverted" tail
  section. Plan: same approach for AIB, BOI, PTSB; AI + reconciliation remains the
  fallback for rare banks / scanned PDFs.
  **Now wired into the pipeline**: `parsers.ts` is a registry (bank → parser);
  `pipeline.ts` uses the deterministic parser when the selected bank has one
  (still running sign-correction + reconciliation for an identical output shape),
  and falls back to AI extraction otherwise. **pdfjs is loaded LAZILY** via
  `lib/core/pdf-loader.ts` (a dynamic `import()`), so it never loads on the AI/
  generic path. The loader installs a **minimal `DOMMatrix` polyfill** before
  importing pdfjs (Node on Vercel has no `DOMMatrix`; we only read text positions,
  no canvas). The pdfjs **worker is imported as a SIDE-EFFECT**
  (`pdf.worker.min.mjs`) so Next.js traces it into the serverless bundle, paired
  with `disableWorker: true` in `getDocument` — we do NOT use
  `GlobalWorkerOptions.workerSrc` (require()-resolving the worker path breaks under
  Next.js ESM). Each parser passes a **copy** of the bytes
  (`new Uint8Array(pdfBytes)`) because pdfjs detaches the buffer it's given.
  `next.config.ts` (not `.mjs`) lists pdfjs-dist under `serverExternalPackages` so
  the bundler leaves it external.
- **AIB parser** (`aib-parser.ts`): AIB's layout is very different from Revolut.
  Columns are Date | Details | Debit € | Credit € | Balance €, all three money
  columns RIGHT-aligned, and their absolute X positions SCALE WITH PAGE WIDTH
  (601pt vs 595pt → anchors × ratio), so anchors are detected PER PAGE from the
  header cells ("Debit €"/"Credit €"/"Balance €", which pdfjs joins into one
  token each) and never hardcoded. Key differences handled: (a) one transaction
  spans several lines and the Balance is printed only sporadically (a checkpoint
  at the end of a block), so a transaction is any line carrying a Debit OR Credit
  amount — Balance presence is irrelevant; (b) the Date appears only on the first
  line of a day and is inherited downward; (c) overdraft balances carry a glued
  'dr' suffix ("3.78dr" = -3.78) ~8pt right of the normal edge; (d) "Interest
  Rate"/"Lending @ x%" rows are informational; (e) FX lines put the original
  amount/rate/fee in Details, only the EUR value lands in a money column; (f) a
  right-hand info sidebar (x0 > 0.72×width) is ignored; (g) each page restarts
  with BALANCE FORWARD. Anchors are taken from the header (always present and
  correctly ordered) then refined toward the body amounts — clustering body
  amounts alone breaks on pages with only one transaction (a lone balance gets
  misread as a credit). Proven on real statements: AIB-3 (1 page, 19 tx, incl.
  overdraft) and a 4-page statement with USD FX (61 tx) both reconcile to the
  cent, and every transaction matches a separately-validated Python reference.
- **BOI parser** (`boi-parser.ts`): Bank of Ireland uses Payments-out /
  Payments-in / Balance columns (NOT Debit/Credit), all RIGHT-aligned, anchors
  detected per page from the header words "out"/"in"/"Balance" (refined with body
  amounts). Key differences from AIB: (a) out and in are SEPARATE columns — the
  same value can appear as both an out and an in (purchase + refund), only x1
  distinguishes them; (b) ONE LINE = ONE TRANSACTION (no separate detail/
  reference lines); (c) overdraft is a SEPARATE "OD" token to the right of the
  balance ("6.00 OD" = -6.00), unlike AIB's glued "dr"; (d) "SUBTOTAL:" is a
  page-closing balance that equals the next page's BALANCE FORWARD (day blocks
  may span pages); (e) "FEE: ..." lines ARE real transactions; (f) FX originals/
  rates are embedded in the description token ("P2908IE700.00@1.16098"), only the
  EUR value lands in a money column; (g) no sidebar. Like AIB, the Balance is
  printed only sporadically (block checkpoint) and the Date is inherited downward.
  Validated against a real 7-page statement (231 transactions): reconciles to the
  cent and every transaction matches a separately-validated Python reference.
  NOTE: validated by replaying the pdfplumber positional dump through the TS
  logic; the in-app pdfjs path should be confirmed on a real BOI PDF (pdfjs may
  tokenize the header differently, as seen with AIB — detection handles both).
- **Multi-PDF upload** (`combine.ts` + `extractAndReconcileMany` in pipeline.ts):
  banks like AIB only generate periodic statements (you can't pick a date range),
  so a user wanting a custom period has several PDFs. The app accepts multiple
  PDFs at once and combines them. `combineStatements` chains them BY BALANCE (one
  statement's closing balance = the next's opening balance): it finds the head
  (opening not any other's closing), follows the chain, and CONCATENATES
  transactions in chain order with each statement's internal order untouched (so
  the running balance stays valid — we do NOT sort transactions by date, which
  would break within-day order and the balance). It detects GAPS (a closing with
  no matching opening = a missing statement) and warns. One reconciliation runs
  over the whole combined series (first opening + Σcredits − Σdebits = last
  closing), which also confirms the statements chain correctly. API
  (app/api/extract/route.ts) accepts "file" (single, unchanged shape) or "files"
  (multiple → returns result + perFile[] + gaps[] + fullyChained). UI shows a gap
  warning, a per-file breakdown table, and a "statements link up" indicator.
  Tested: clean chain orders correctly from shuffled input and reconciles; a
  missing statement is flagged; two real AIB PDFs of different accounts correctly
  report fullyChained=false with a gap.
- **Per-bank prompts** (`prompts.ts`): a base prompt (generic, any bank) plus
  optional bank-specific rules appended for known banks. `getPrompt(bank)`
  returns the right one. Revolut rules are implemented (e.g. the "Comision/Fee"
  shown in a transaction's sub-text is informational, NOT a separate transaction).
  The target banks are AIB, BOI, PTSB, Revolut (≈90% of the user's real volume).
  The bank is currently chosen via a UI dropdown (and sent per request); later,
  automatic bank identification can select it — the registry stays the same. To
  add a bank: add one entry to BANK_RULES in `prompts.ts`.
- **Robust JSON handling** (`gemini.ts`): output token limit raised so large
  statements aren't truncated; on a parse failure the response is repaired
  (raw control chars inside strings are escaped; thousands-separator commas in
  numbers like 1,000.00 are stripped) before a second parse; clear errors if it
  still fails. (These two repairs fixed real crashes on Revolut RO.)
- **Model cascade** (`pipeline.ts`): tries the primary model first; if
  reconciliation fails AND fallback is enabled, retries with a fallback model.
  Returns the result plus a record of every attempt (model, pass/fail,
  discrepancy, duration) for stats. The primary model, fallback model, and
  fallback on/off are all **selectable from the UI per request** (test controls).
  When the caller omits them (e.g. a future API), defaults from `config.ts` apply:
  primary `gemini-2.5-flash-lite`, fallback `gemini-2.5-pro`, fallback OFF.
  The backend validates model names against an allow-list in `config.ts`.
- **Retry with backoff** (`gemini.ts`): transient errors (429/500/502/503/504,
  timeout, network) are retried up to 4 attempts with 1s→2s→4s backoff. Auth /
  bad-request errors fail immediately (not retried).
- **Gemini key sent via `x-goog-api-key` header** (not the `?key=` URL param),
  required for the newer `AQ.`-prefixed keys.
- **Thinking mode disabled** (`thinkingConfig: { thinkingBudget: 0 }`) for speed.
- **Timeout** of 5 min per request as a safety net.
- **Upload guard**: 15 MB max, PDF only.
- **UI**: signature reconciliation equation (verdict), running-balance column,
  extraction trace (model stats), CSV export, a row-by-row balance diagnosis that
  highlights exactly which row breaks, and test controls (primary/fallback model
  selectors + fallback toggle, defaulting to lite / pro / off).

### Known testing notes

- Statements extract and reconcile correctly on real data (e.g. permanent tsb,
  8 pages / 292 transactions, reconciled on flash-lite). A 42-page AIB statement
  (863 transactions) previously failed reconciliation by a round 2880.00 on a
  single-call extraction — the hardest case.
- On Vercel's free (Hobby) tier, serverless functions time out at 60s. A single
  whole-PDF call exceeded this for large statements. Page parallelization (above)
  addresses this by keeping each chunk small; combined with API billing (to lift
  rate limits so many chunks can run at once) it handles large statements.
- The reconciliation, cascade, retry, merge, and balance-break logic are all
  unit-tested. PDF splitting is verified. The live Gemini call is validated on
  real uploads.

**Immediate next step:** run the feasibility test across 15-20 varied real
statements (Revolut, other banks, different sizes), record the reconciliation
pass rate and where the model errs, then tune the prompt or move to the next
layer (bank identification + saving results).

---

## Conventions

- **All code, comments, and UI text in English.**
- **UI copy centralized** in `lib/strings.ts` (not scattered through components).
- **Money in integer cents.** Reconciliation tolerance ±2 cents.
- **Server-only secrets.** AI key never in the browser.
- **Small, modular, supervised steps.** Explain non-obvious code. Keep each piece
  replaceable. Prefer clean and correctable over clever or "complete."
