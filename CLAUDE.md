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
  every statement + reconciliation (with the flash-lite→flash cascade). Add templates
  later, once the base engine is proven and there is data on which banks dominate.
- **No enterprise features (teams, API plans, SOC 2) yet.** Add when justified.

Note: the model **cascade** (primary → fallback on reconciliation failure) IS now
implemented in `pipeline.ts`. Models and fallback on/off are selectable from the
UI per request, with defaults in `config.ts` (lite / flash / off). Keep fallback on
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
├── api-types.ts           → the /api/extract response shape as the client sees it (type-only)
├── recent-store.ts        → BROWSER: IndexedDB store of the last 5 reconciliations (result + edits + ticks)
├── features/page.tsx      → /features — what the app can do, for users (linked in dev view for now)
├── changelog/page.tsx     → /changelog — static list of notable changes (linked only in dev view)
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
│   ├── revolut-consolidated-parser.ts → SEPARATE parser for Revolut "Custom"/
│   │                        consolidated statements (multi-account; per-account reconcile)
│   ├── aib-parser.ts      → DETERMINISTIC AIB parser (pdfjs; right-aligned cols, scales w/ width)
│   ├── boi-parser.ts      → DETERMINISTIC BOI parser (pdfjs; Payments-out/in cols, OD overdraft)
│   ├── ptsb-parser.ts     → DETERMINISTIC PTSB parser (anti-extraction font; digit cipher
│   │                        solved from balance arithmetic)
│   ├── ptsb-descriptions.ts → SERVER: PTSB descriptions read off the rendered pages by
│   │                        AI (route-level; numbers/reconciliation never touched)
│   ├── parsers.ts         → registry mapping banks → deterministic parsers
│   ├── combine.ts         → chains multiple statements by balance, detects gaps
│   ├── multi-account.ts   → PURE, client-safe: dedupeLabels + mergeAccounts (combined table)
│   ├── multi-account-extract.ts → SERVER: extractAccounts (one client, several bank accounts)
│   ├── pdf.ts             → PDF splitting into page-chunks (pdf-lib, server-only)
│   ├── extraction.ts      → split + parallel extract + merge (provider seam)
│   ├── pipeline.ts        → extract-and-reconcile cascade + per-model stats
│   ├── sign-correction.ts → balance-based debit/credit auto-correction
│   ├── categorization.ts  → category per transaction: keyword RULES first, AI only for the rest
│   ├── expenses.ts        → PURE: parse expenses.csv + match each expense to a statement debit
│   ├── csv-import.ts      → PURE: parse a previously-EXPORTED transactions CSV or Excel workbook back
│   │                        into accounts (inverse of toCsv / transactionSheet); browser reads in app/import-file.ts
│   ├── verification.ts    → CSV export + row-by-row running-balance check
│   └── excel.ts           → PURE: Excel (.xlsx) sheet builders (transactions / summary / expenses)
├── features.ts            → hand-curated feature list DATA (grouped by task), rendered by app/features
├── changelog.ts           → hand-curated changelog DATA (newest first), rendered by app/changelog
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
  x1≈556 (right-aligned), tolerance ±6 — all measured on Revolut's usual ~595pt-wide
  page. Revolut also issues a **NARROWER 560pt template**: identical layout, every
  column shifted proportionally left (money-out at x0≈316, well outside the ±6
  tolerance, so nothing matched and the statement yielded 0 tx). `extractTokens`
  therefore normalizes each token's X by `595 / pageWidth` — a <0.3pt no-op on the
  ~595pt statements (all 308 in the corpus) and the whole fix for the narrow one.
  Main transaction rows are font size ≥7;
  sub-rows (fee/FX-rate/reference, size≈4.5) are skipped so amounts come only
  from the main row. **Money tokens are recognized by a currency symbol prefix
  (€/$/£) OR a 3-letter code suffix (e.g. "140,514.30 RON")**, so RON / other-
  currency Revolut accounts work; foreign figures on (skipped) sub-rows like
  "72.00 MDL" are ignored. **Both number formats** are parsed (English 1,234.56 and
  European 1.234,56 — rightmost separator is the decimal) and dates in RO/EN/RU,
  both orders ("10 apr. 2024", "Jun 11, 2024", "15 янв. 2024 г."). Extraction
  starts after the transaction-table header (RO "Dată Descriere … Sold" / EN "Date
  Description … Balance" / RU "Дата Описание Списания … Остаток") — matched by the
  description + money-out words, since the balance word can wrap onto its own line.
  It **skips per-statement summary rows** ("Cont"/"Account"/"Продукт"/"Total",
  detected by a currency token in the opening-balance column at x0≈253). A single PDF
  may concatenate **several current-account periods** (each "Account transactions …"
  + Balance summary + table + a "Reverted" tail), chained by balance — so the parser
  does **NOT** stop at the reverted/refunded tail ("Înapoiate"/"Reverted"): those
  rows have no Balance column and are skipped on their own, and the next period's
  table header re-syncs extraction (proven on `en/7`: 2 periods, 3170 tx, full year).
  It **SKIPS SEPARATE-account sub-statements**, resuming at the next current-account
  title — savings/deposits
  (EN "Deposit transactions …" / RO "Depuneri de la …" / RU "Операции пополнения …"),
  pockets/vaults (RO "Tranzacții din Buzunare …" / "Tranzacții din Seifuri …" / RU
  "Операции по … сейфам" and pockets "Операции по … кошелькам"), and sub-accounts
  opened for others (RO "Tranzacții din contul pentru <Name> …" / EN "account for
  <Name>" / RU "Операции по счету пользователя <Name> …") — all carry their own
  balance series (`isSeparateAccountSection`, matched on large ~12.4pt title lines;
  the size gate keeps the everyday "Пополнение счета" top-up *transactions* from
  matching the savings-section word). Missing these RU sections previously corrupted
  the closing balance (their last row, often 0.00, overwrote it) and made several RU
  statements fail. These sections do **NOT** always come last, which is why they are
  skipped rather than stopped at: a long period is emitted as several blocks, each
  with its OWN pockets section ("Account … 1 Jan → 16 Mar", "Pockets …", "Account …
  16 Mar → 31 Dec", "Pockets …"). Treating the first one as a permanent stop silently
  dropped every later period — one real statement lost 69 of its 94 pages **while
  still reconciling**, because a truncated balance series is self-consistent (the
  danger case: a clean ✓ on a quarter of the data). Extraction resumes at the next
  current-account title (`isCurrentAccountSection` — EN "Account transactions from",
  RO "… din cont de la", RU "Операции по счету с"), checked BEFORE the separate-account
  test because each locale's sub-account title shares its prefix and only the
  continuation differs ("cont de la" vs "contul pentru", "по счету с" vs "по счету
  пользователя", "Account transactions" vs "Account for <Name>").
  **Glued description+amount tokens**: pdfjs sometimes emits an outgoing transfer row
  ("Перевод SWIFT … 607,00€") as ONE text item that glues the description and its
  trailing amount, with x0 in the description zone but x1 reaching a money column —
  so the amount would be missed and the row would show 0/0. `splitGluedAmount` detects
  this (a currency token with real description text before a trailing amount) and
  splits it into a description token + a synthetic amount token placed EXACTLY at the
  matching column anchor (debit vs credit chosen by the token's right edge). A PURE
  amount whose currency is a 3-letter code (e.g. "168.99 RON", the summary "Sold
  inițial" cell) is NOT split — there is no description text before the amount — so
  RON-currency summary rows keep their position and are still skipped. **Multi-currency bundles** (one PDF with current accounts in DIFFERENT
  currencies, e.g. "Extras EUR" + "Extras GBP") ARE handled: `parseRevolutAccounts`
  detects the per-page currency from the big page header and splits the pages by
  currency; `extractRevolut` (pipeline) reconciles EACH currency separately and
  returns the per-account (consolidated-shaped) result — single-currency statements
  are untouched. NOT handled: the Revolut CSV/Excel export rendered as PDF
  (Type/Product/…/Amount/Fee/…/Balance columns, one signed Amount) → yields no-tx
  (a distinct format / future parser).
- **Revolut consolidated / "Custom" statement** (`revolut-consolidated-parser.ts`):
  a DIFFERENT document — ONE PDF bundling many accounts (several current accounts in
  different currencies, plus savings & crypto) with lots of summary pages and a
  different transaction layout (Date | Description | Category | signed amount |
  Balance | Tax | Fees — no separate debit/credit columns). It gets its OWN parser
  (the per-account `revolut-parser.ts` is untouched), selected via the separate bank
  `revolut-consolidated`. **MVP scope: the current-account sections only** (EN/RO/RU),
  each reconciled SEPARATELY (own currency + balance series); the pipeline returns
  `ConsolidatedPipelineResult` (each account carries its own `transactions[]`) and the
  UI shows a per-account summary plus one detailed, individually-exportable (CSV)
  transaction table per account (0-tx accounts are listed but not detailed). **Each
  summary row's account name is a JUMP LINK to that account's detail table**
  (`jumpToAccount` in `page.tsx`, the block-level twin of `jumpToRow`: an `id` on the
  `.account-detail` block, smooth scroll respecting prefers-reduced-motion, brief
  flash) — the tables run to thousands of rows, so the summary is the page's index.
  The anchor id uses the UNFILTERED account index (the detail loop filters out 0-tx
  accounts, which would otherwise shift every later index). Navigation is TWO-WAY: each
  account block carries a "↑ Back to accounts" link (`jumpToSummary`, targeting the
  summary card's `accounts-summary` id) in its header row — except the FIRST block,
  which sits directly under the still-visible summary; at the END of a table the next
  account's header follows immediately with its own link — the floating
  back-to-top button is not a substitute, it lands above the summary on the upload card. Money values are
  read with a grouping-aware regex (handles `1,000.00` / `1.000,00` / `9 271,00`,
  € prefix/suffix, and amount+balance merged into one token). **Dates come in BOTH
  orders**: day-first ("5 Mar 2025", "20 нояб. 2025г.") and month-first ("Mar 5,
  2025") in Revolut's newer template — `toIsoDate` reads both, and `DATE_ROW_RE`
  (which decides whether a line IS a transaction row) accepts both shapes. It
  previously required day-first only, so a month-first consolidated statement matched
  no rows at all and every account came back with 0 tx. Savings/crypto sections
  are out of scope for now. **A user can hold BOTH a personal and a JOINT current
  account in the same currency** — `ACCOUNT_TITLE` matches "Cont personal"/"Personal
  Account"/"Личный счет" AND "Cont comun"/"Joint Account"/"Совместный счет" (each is a
  SEPARATE account + balance series, so both must start a new account; missing "Cont
  comun" merged its rows into the personal account and broke reconciliation).
  **The section TITLE varies between RO templates**: "Conturi curente **Extrasuri de
  tranzacționare**" and, in the `ro-md` template, "Conturi curente **Extrase pentru
  tranzacții**" — both the noun and the preposition differ, so `SECTION_START` matches
  `extras(uri|e)\s+(de|pentru)\s+tranzac` (still narrow enough that the SUMMARY title
  "Conturi curente Rezumate" does not match). Knowing only the first wording meant the
  transaction section was never entered on an ro-md statement: 0 accounts and
  `currentAccountsSection: false`, which the rule below then reported as a clean
  "nothing in scope" **PASS** — on a PDF holding a full year of transactions. That is
  the same danger class as a truncated-but-reconciling balance series: a green verdict
  over missing data. `SECTION_STOP` now also matches **"criptomonede"** (RO does not
  spell the crypto section "crypto"): its rows carry a date + amount + balance, so
  without the stop they would be appended to the LAST current account and corrupt its
  balance series — currently masked only because the "Informații despre …" page happens
  to precede the crypto section in these files.
  **No current accounts in scope ≠ failure**: a consolidated PDF with NO
  "Current Accounts transaction statements" section (savings/crypto-only, or an empty
  period) has nothing to reconcile in MVP scope — the parser reports
  `currentAccountsSection: false` and the pipeline returns `allReconciled: true` (0
  accounts), NOT a fail. Verified: all current accounts across real EN/RO/RU
  consolidated statements reconcile to the cent (incl. the `ro-md` 2022 + 2023
  statements: EUR/GBP/USD to the cent, empty RON correctly `no-tx`, and each account's
  opening/closing cross-checked against the statement's own printed "Sold inițial /
  Sold final" summary and against the other year's statement, which they chain to);
  savings/crypto-only and empty consolidated statements pass as "nothing in scope".
  **See `WORKFLOW.md` for the full Revolut template reference + diagnostic recipe.**
  Plan: same approach for AIB, BOI, PTSB; AI + reconciliation remains the
  fallback for rare banks / scanned PDFs.
  **Now wired into the pipeline**: `parsers.ts` is a registry (bank → parser);
  `pipeline.ts` uses the deterministic parser when the selected bank has one
  (still running sign-correction + reconciliation for an identical output shape),
  and falls back to AI extraction otherwise. **AI fallback on empty**: if a
  deterministic parser returns ZERO transactions (an unreadable layout — a scanned
  PDF, or an anti-extraction font like PTSB's "AllAndNone", where the digits aren't
  in the text layer at all), the pipeline falls back to AI vision, which reads the
  rendered page. Controlled by `PipelineOptions.allowAiFallback` (default **true**
  in the app; the regression harness passes **false** so it stays deterministic and
  makes no AI calls). **Exception — valid empty statement**: 0 transactions is NOT
  always "unreadable". A dormant/no-activity month is a real, readable statement
  with no postings. So before falling back, the pipeline checks: if the parser
  returned 0 tx but the result **reconciles** (opening == closing) AND a **real
  balance was read** (`openingBalance !== 0 || closingBalance !== 0`), it's a valid
  empty statement → returned as a PASS, no AI call. The "balance ≠ 0" gate
  separates a genuine empty month (e.g. opening = closing = 383.35) from an
  unreadable PDF (parser finds nothing → 0/0 → still falls back to AI). **pdfjs is loaded LAZILY** via
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
  with BALANCE FORWARD — and **loan statements** print "OPENING BALANCE" (often
  0.00, before the drawdown) on page 1 instead, with BALANCE FORWARD on later
  pages; BOTH are recognized as the opening/checkpoint row (the FIRST is the
  statement opening). Missing "OPENING BALANCE" made loans fail by exactly the
  opening: page-1 postings were counted while the opening was taken from page 2's
  forward. Anchors are taken from the header (always present and
  correctly ordered) then refined toward the body amounts — clustering body
  amounts alone breaks on pages with only one transaction (a lone balance gets
  misread as a credit). Proven on real statements: AIB-3 (1 page, 19 tx, incl.
  overdraft) and a 4-page statement with USD FX (61 tx) reconcile to the cent, as
  do AIB loan statements (all-overdraft "Xdr" balance series).
- **BOI parser** (`boi-parser.ts`): Bank of Ireland uses Payments-out /
  Payments-in / Balance columns (NOT Debit/Credit), all RIGHT-aligned, anchors
  detected per page from the header words "out"/"in"/"Balance" (refined with body
  amounts). Key differences from AIB: (a) out and in are SEPARATE columns — the
  same value can appear as both an out and an in (purchase + refund), only x1
  distinguishes them; (b) ONE LINE = ONE TRANSACTION (no separate detail/
  reference lines); (c) overdraft is marked by "OD" to the right of the balance
  ("6.00 OD" = -6.00), unlike AIB's glued "dr" — handled whether pdfjs emits a
  SEPARATE "OD" token or JOINS it to the amount as one token ("6.00 OD"); the
  joined form was missing the final closing balance and made fee-ending statements
  fail by exactly the maintenance fee; (d) "SUBTOTAL:" is a
  page-closing balance that equals the next page's BALANCE FORWARD (day blocks
  may span pages); (e) "FEE: ..." lines ARE real transactions; (f) FX originals/
  rates are embedded in the description token ("P2908IE700.00@1.16098"), only the
  EUR value lands in a money column; (g) no sidebar; (h) a **no-activity month**
  (page has only "BALANCE FORWARD", no postings, no SUBTOTAL) sets
  `closingBalance = the balance forward` on the BALANCE FORWARD branch, so opening
  == closing and it reconciles with 0 transactions (the pipeline's "valid empty
  statement" rule then returns it as a PASS instead of falling back to AI). Like
  AIB, the Balance is printed only sporadically (block checkpoint) and the Date is
  inherited downward. Validated against a real 7-page statement (231 transactions):
  reconciles to the cent and every transaction matches a separately-validated
  Python reference. Confirmed on the real in-app pdfjs path across multiple BOI
  statements (the regression harness): current accounts incl. fee-ending,
  overdraft, and no-activity months, and a loan statement (all-OD balance series),
  reconcile to the cent. The header and the "OD" marker are both handled whether
  pdfjs splits or joins their tokens. **Encrypted PDFs**: BOI exports are often
  permission-encrypted with an EMPTY user password; pdfjs decrypts them
  transparently, so the deterministic parser reads them with no special handling.
  (pdf-lib — used only on the AI path — cannot open them; see `pdf.ts`.)
- **PTSB parser** (`ptsb-parser.ts`): permanent tsb renders the body in an
  ANTI-EXTRACTION font ("AllAndNone", a CFF CIDFont) — glyphs display correctly but
  the text layer is scrambled: ToUnicode has **0 digit mappings** and no glyph
  names, so amounts can't be read as text. We decode the cipher from ARITHMETIC, not
  the font. Columns are clean (Date | Details | Withdrawn | Paid In | Balance, anchored
  from the header which is a normal font) and a Balance prints on ~every row. Each
  money cell is a positional number over a small fixed set of "digit symbols" (the
  decimal symbol is always 3 from the end), so each amount is a LINEAR function of the
  unknown digit values. The running balance gives hundreds of equations (balance =
  prevBalance + Σ signed movements since the last printed balance); a DFS solves the
  symbol→digit bijection (all-different) — the constraints make the solution UNIQUE,
  and reconciliation is the final proof. Dates: day/year are digits (solved), the
  3-letter lowercase month maps via a FIXED table (the AllAndNone code→letter map is
  constant across PTSB statements; month codes derived once by a CSP that makes the
  triples spell the 12 months). Descriptions are best-effort with the same fixed
  letter map (limited — the font's uppercase/other glyphs aren't all mapped). If the
  solver can't find a UNIQUE map, the parser returns 0 transactions → AI fallback.
  Validated on the regression harness: 12 real PTSB statements (current accounts,
  including a 38-page combined file, 1394 tx) reconcile to the cent.
  **Overdrawn balances** are printed as the amount, a space, then a single marker
  glyph ("123.45 <od>") — the same idea as BOI's "OD" and AIB's glued "dr". The space
  made `amountCell` reject the whole cell, so an overdrawn row silently lost its
  balance: the closing balance then stalled at the last POSITIVE one while the
  reconstructed running balance carried on, and the statement failed by exactly the
  movements after that point. `findBalanceBreaks` could not see it, because the parser
  stores the RECONSTRUCTED running balance on each row, not the printed one — so the
  series is self-consistent by construction. The marker is now stripped and the sign
  carried on the cell; only the Balance column honours it (withdrawn/paid-in are
  magnitudes whose direction comes from their column).
  **Column split**: the Details text starts well LEFT of its own header label —
  measured across the corpus, the date cell sits at x0 ≈ 30-35 (header "Date" at ~36)
  and the details text at x0 ≈ 70, with nothing in between, while the "Details" header
  sits at ~124. Splitting at the header therefore swallowed most of each description
  into the date cell, which also made `decodeDate` read digits out of the description:
  its month lookup then failed and the row INHERITED the previous row's date (17
  distinct dates instead of 30 on one statement). Splitting in the measured gap
  (`DATE_COL_WIDTH`) fixed both — dates now come from each row's own date cell
  (verified by decoding the raw glyphs: the balance-forward row reads 24DEC24 and the
  first posting 30DEC24, and the balances chain exactly to the previous statement).
  Rows carry `page` (Source column + the AI layer's page alignment), `descriptionKey`
  (the Details cell's raw glyph codes) and `openingDate` (the balance-forward row's
  date, for multi-PDF gap detection, as AIB/BOI do).
- **PTSB descriptions — the hybrid layer** (`ptsb-descriptions.ts`): the cipher
  recovers every NUMBER, but the font's poisoned ToUnicode means descriptions decode
  only as fragments ("posaleapacard" for "POS SALE APPLE CARD") — the glyph codes
  collide, so no code→letter map can fix it (see the June 2026 investigation). The
  glyphs RENDER correctly, though, so a vision model reads the page as a person does.
  `fillPtsbDescriptions` takes **all the PDFs of a request at once** (several
  statements of one account, or several PTSB accounts), splits each with the existing
  `splitPdfIntoChunks`, skips slices whose pages carry no transactions, reads them all
  in parallel via `describeWithGemini` under ONE concurrency budget, and grafts each
  reading onto the row the parser already produced. **A row is relabelled ONLY when the
  model's own reading of that row's Withdrawn/Paid In agrees TO THE CENT** — the
  amounts are an identity check, never data — so a misread page degrades to the partial
  decode instead of mislabelling a transaction. Rows the model skipped are recovered via
  `descriptionKey` (identical glyph codes ⇒ identical printed text; the map is kept PER
  DOCUMENT, since the font is subsetted per PDF). It runs in the ROUTE, like
  `categorization.ts` — never in the pipeline — so the regression harness keeps testing
  the deterministic core with no AI calls, and it runs BEFORE expense matching and
  categorization, which both read description text. Always on for PTSB (nothing else
  can read those descriptions) and fail-soft: a failed slice, a missing API key or an
  unsplittable PDF leaves the partial descriptions and still returns a reconciled
  statement.
  **Speed + the two-model cascade** (config: `DESCRIBE_PAGES_PER_CHUNK`,
  `DESCRIBE_CONCURRENCY`, `DESCRIBE_RETRY_MIN_FILL`, `DESCRIBE_RETRY_DEADLINE_MS`):
  this is the one AI step that is always on, so its wall time decides whether a big
  statement fits the 60s serverless limit. It reads **ONE page per call** on
  **flash-lite** with **24 in flight**; a page is the smallest slice that still shows a
  whole table, and small slices both parallelize better and contain a misreading. Then
  any slice whose rows came back **less than 90% matched is re-read by flash** — the
  fast model occasionally reads a wrapped line as an EXTRA row and from there runs one
  row out of step with the parser, losing the rest of the slice; that is systematic
  (repeating the same call reproduced 24/106 matched, flash got 106/106), so the retry
  escalates the model instead of repeating. Only bad slices pay for it, and the retry
  wave is skipped once the pass is already 30s in (fail-soft beats a timeout).
  Measured on the 38-page/1394-row worst case: **~29s → ~20s** and 1393/1394 rows
  filled (was 1389); five statements of one client, 920 rows: **~40s sequential → ~18s**,
  917 filled. Remaining ceiling is the key's throughput (~80 rows/s), i.e. a few
  thousand rows per request; past that the fix is structural (descriptions from a
  second request, or a higher `maxDuration`), not a bigger concurrency number. **In multi-account mode an account's PDF bytes
  are resolved through `MultiAccount.sourceIndex` — the input it came from — never by
  file name.** Two accounts of one client routinely upload same-named files
  ("statement.pdf", "1.pdf"); a name lookup handed one account the OTHER account's
  document, and because the amount check only compares cents, any coincidental amount
  match (a €10 fee, a recurring direct debit) wrote the wrong merchant onto a row —
  silently, since the numbers still reconciled. Caught by an adversarial review that
  reproduced it on the real corpus (14 of 15 document pairs mislabelled rows). Tests:
  `npm run test:ptsb-descriptions` (pure matching rules — no PDF, no AI) and a
  provenance assert in `npm run test:multi`.
- **Multi-PDF upload** (`combine.ts` + `extractAndReconcileMany` in pipeline.ts):
  banks like AIB only generate periodic statements (you can't pick a date range),
  so a user wanting a custom period has several PDFs. The app accepts multiple
  PDFs at once and combines them. `combineStatements` orders the statements
  **CHRONOLOGICALLY by their transaction date range** (start, then end; undated
  statements last, stable) and CONCATENATES them with each statement's internal order
  untouched (so the running balance stays valid — we sort whole STATEMENTS, never
  individual rows by date, which would break within-day order and the balance).
  **Ordering is NOT balance-chain-based**: some banks print the balance only
  sporadically (AIB shows it at block checkpoints, so many rows carry 0), which made
  closing→opening linking mis-order the statements — the classic symptom being an
  account whose PDFs came out in file/alpha order (April, January, …) instead of by
  date, and which then failed reconciliation because the wrong statement was picked as
  the opening/closing endpoint. Date-ordering fixed both (verified: AIB 589 + AIB 662,
  previously off-by, now reconcile to the cent and read chronologically). **GAP
  DETECTION runs on the chronological order** (NOT by re-deriving order from balances).
  A statement is missing between two consecutive statements when EITHER (a) their
  balances don't carry over — this closing ≠ next opening (a **balance break**), OR
  (b) there's a large **date jump** between them (≈ a whole period missing). `fullyChained`
  = no gaps. Two reasons for the date check: (1) the OLD balance-chain segment approach
  produced FALSE gaps when a balance value repeated as both an opening and a closing —
  AIB 589 both OPENS at 0 (genuine start) and later CLOSES at 0, so head-detection linked
  October's closing 0 to January's opening 0 (a quarter out of place) and reported a
  spurious gap; chronological-adjacency removed those (AIB 589 now `fullyChained`). (2)
  A missing statement that nets to ZERO (opening == closing) is INVISIBLE to the balance
  chain — its neighbours still chain (…0 → 0…) and reconcile — so only the date jump
  reveals it. The date threshold is **adaptive** — half the median statement span,
  floored at `GAP_MIN_DAYS` (25) — so the normal few-day seam between consecutive
  statements never trips it, but a whole missing period does. **The date-jump seam uses
  each statement's DECLARED opening date, NOT its first transaction.** A statement's true
  period start is its BALANCE FORWARD / OPENING BALANCE row date (captured by the AIB/BOI
  parsers as `StatementData.openingDate`), which can PRECEDE the first posting: AIB 662's
  Feb statement OPENS on 22 Aug 2024 (balance 0) but its first transaction is 2 Dec — a
  116-day DORMANT stretch INSIDE one statement, not a hole between statements. Using the
  first transaction made this a FALSE gap; using `openingDate` (22 Aug, 14 days after the
  previous statement's last posting) correctly reports NO gap (AIB 662 is `fullyChained`,
  reconciles to the cent, nothing missing). Revolut/consolidated don't set `openingDate`
  → fall back to the first transaction (they're transaction-dense, no dormant start).
  (Residual: a statement dormant at its END could rarely give an advisory false positive
  — period end is the last transaction — hence the "possible missing statement" wording;
  a future precise upgrade is also capturing the declared closing date.) One reconciliation runs over the
  whole combined series (first opening + Σcredits − Σdebits = last closing). **Duplicate
  detection**: before chaining, `extractAndReconcileMany` drops exact-content
  duplicates — the SAME statement uploaded twice, often under a DIFFERENT file name
  (matched by `contentKey` = opening/closing + every transaction, NOT the file name).
  Only statements WITH transactions are considered (two genuinely empty months with
  the same balance aren't flagged). The first copy is kept; the rest are returned in
  `duplicates[]` and excluded from the series — otherwise two identical statements
  (same opening AND closing) wouldn't chain, doubling transactions and showing a FALSE
  gap. API (app/api/extract/route.ts) accepts "file" (single, unchanged shape) or
  "files" (multiple → returns result + perFile[] + gaps[] + fullyChained +
  duplicates[]). UI shows a duplicate warning, a gap warning, a per-file breakdown
  table, and a "statements link up" indicator. Tested: clean chain orders correctly
  from shuffled input and reconciles; a missing statement is flagged; a renamed copy
  is detected, excluded, and yields the same result as not uploading it.
- **Multiple bank accounts** (`multi-account.ts` + `multi-account-extract.ts`, BACKLOG
  3.1): one client often holds several accounts (e.g. AIB + BOI + Revolut). The UI's
  "**+ Add another bank statement**" button (appears once the first bank's PDFs are
  attached) adds removable account blocks — each with its own bank, an OPTIONAL label,
  and its own PDF(s) (multiple allowed → chained via `extractAndReconcileMany`). Each
  account is reconciled **INDEPENDENTLY** by its own parser; the result shows, PER
  ACCOUNT, a header (label · bank · tx · ✓/✗ · CSV export) plus a **per-statement
  breakdown** — one row per PDF with its **File · Transactions · Period · Balance range**
  (reuses `perFile`; a single-file account is synthesised into one row via
  `accountStatements` in `page.tsx`) — plus **ONE combined transaction table** with the
  account **label as the first column** (filterable/sortable like any other column). **Labels** default to the bank's SHORT
  name (`SHORT_BANK_LABELS` in `prompts.ts`; "Bank of Ireland" → **"BOI"**), the user's
  label wins, and duplicates are numbered ("BOI", "BOI (2)"). **Scope is deliberately
  reduced**: there is NO cross-account transfer detection and NO synthetic cross-account
  reconciliation — the overall verdict is simply "all accounts reconcile". Architecture:
  the pure half (`multi-account.ts` — `dedupeLabels` + `mergeAccounts`, type-only imports)
  is client-safe so `app/page.tsx` merges the rows in the browser (rows are NOT sent
  twice); the server half (`multi-account-extract.ts` — `extractAccounts`) dispatches
  each account to the right pipeline entry point (Revolut multi-currency splits into
  per-currency accounts), applies labels, and computes the verdict. API: a new `accounts`
  JSON field `[{bank, label}]` + files under repeated `account-<i>` keys (caps: 8 accounts,
  60 files total, 40-char labels), backward-compatible with the `file`/`files` paths;
  returns `{ multi: { accounts, allReconciled }, fileName: "N accounts · M files" }`.
  `Transaction.accountLabel` (display-only) carries the source into the merged table +
  CSV as an **"Account" column, ALWAYS shown**: the extract route stamps
  `SHORT_BANK_LABELS[bank]` on a single-account statement's rows (so even one bank gets the
  column) and multi-account carries per-account labels. `toCsv` prepends the column ONLY
  when a row carries `accountLabel`; the deterministic CORE never sets it, so harness
  snapshots (taken from the core, not the route) stay byte-identical. In multi-account mode the single-statement equation/
  balance-breaks/dev-trace are hidden (they're per-extraction concepts), BUT the **Financial-period bar
  IS shown**: selecting a year/range slices EACH account (`slicePeriod` in `lib/core/period.ts`) and
  **re-reconciles it** (opening/closing from that account's running balance), so the per-account
  verdicts, the combined table and every CSV reflect the period — just like a single statement
  (`displayMulti` in `page.tsx`; per-file breakdown shown only for the full period). Headless test:
  `npm run test:multi` (synthetic asserts + real clients under `statements/interbank/<n>/`,
  **each numbered folder = one separate client**). Verified end-to-end: 4×AIB+Revolut and
  BOI+Revolut clients reconcile per account, labels dedupe, combined table is chronological.
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
  primary `gemini-2.5-flash-lite`, fallback `gemini-2.5-flash`, fallback OFF
  (Pro was removed from the model list; the allow-list is flash-lite + flash).
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
  selectors + fallback toggle, defaulting to lite / flash / off). The verdict has a
  third **"soft" (amber) state** for an out-of-balance that is fully explained by a
  known bank-side inconsistency (e.g. Revolut crypto-sell spreads — see
  `isExplainedByCryptoFees` in `verification.ts`), so it's visually distinct from a
  genuine reconciliation failure. Extraction stays faithful; only the verdict's
  presentation softens.
  **Clear + Cancel** (`app/page.tsx`): the Reconcile row has ONE secondary slot beside
  the primary button — empty when nothing is attached, **Clear** whenever there is
  something to clear (files attached, a result or an error), **Cancel** while a run is in
  flight (swapped in place, same style, so the row never jumps). **Clear** starts over
  without a refresh — drops the attached PDFs, extra accounts, labels, expenses/CSV
  files, the period and the result; bank/model settings and the PDF/CSV mode persist.
  Every file input is rendered by **`app/file-picker.tsx`** — a hidden native input
  behind a "Choose files" button and an **"Uploaded N files"** status driven by the
  parent's state (the browser's own text can't be changed and goes stale when a file is
  ✕-removed from the list), so Clear/removal keep the text in sync with no DOM reset;
  the hidden input's value is cleared after each pick so the same file can be re-picked
  after a removal. **Cancel** aborts the
  in-flight reconciliation: an `AbortController` per run → `xhr.abort()`; the catch
  branch turns the `AbortError` into a muted "Reconciliation cancelled." note (no red
  error), the files stay attached, Reconcile is re-enabled. **The cancel reaches the
  server**: the route passes `req.signal` (fires when the browser disconnects) as an
  optional `signal` through `PipelineOptions` → `extractStatement` → `extractWithGemini`,
  and to `categorizeTransactions` / `fillPtsbDescriptions`; in `gemini.ts` the signal
  aborts the in-flight `fetch` and a `RequestCancelledError` (a `FatalGeminiError`, so
  never retried, no backoff sleep) ends the retry loop, so an abandoned request stops
  spending on AI. `signal` is optional everywhere — the harness/tests never set it — and
  the deterministic parsers are not interruptible (seconds, no network). The CSV
  re-import is client-side and instant, so it has no Cancel.
- **Transaction categorization** (`categorization.ts`, BACKLOG 1.1): assigns each
  transaction a single `category` from a FIXED list (`CATEGORIES`, "Other" fallback),
  using AI as little as possible. **Layer 1 — keyword RULES** (zero AI, deterministic,
  ordered, first match wins) catches the majority for free (~55% of rows on the test
  set); rules are calibrated on the real test descriptions (Irish merchants + Revolut
  transfers/savings/crypto/gambling), with ordering to avoid collisions ("tesco mobile"→
  Telecom before "tesco"→Groceries) and word-boundary regex where needed (`\bfee\b` not
  "coffee", `\brent\b` not "current"). **Layer 2 — Gemini** only for the rest: the
  unmatched rows are DEDUPED by a normalized merchant key (`normalizeDescription`) and
  the UNIQUE descriptions are sent in PARALLEL batches (`mapWithLimit`,
  `MAX_CONCURRENT_CHUNKS`) via `categorizeWithGemini` (reuses gemini.ts plumbing; strict
  JSON description→category, "Other" on uncertainty); the answer is applied back to every
  row sharing the key ("Tesco" asked once). Runs AFTER reconciliation as a SEPARATE step
  (in `app/api/extract/route.ts`, gated by the `categorize` form flag) — it mutates
  `category` in place and NEVER affects reconciliation, so the pipeline/harness are
  untouched. UI: a production toggle "Categorize transactions" (cost control), a
  **Category** column in the tables (shown only when categorized) and in the CSV export.
  **Inline editing (BACKLOG 1.2):** the Category cell is click-to-edit via a small styled
  combobox (`app/category-combobox.tsx`) that lets the user PICK from `CATEGORIES` (plus any
  custom categories already used this session) OR TYPE a custom one. Its menu is rendered
  through a PORTAL to `<body>` (positioned `fixed` under the cell) because the table has
  `overflow: hidden` — a native `<select>`/`<datalist>` popup would be clipped or, for
  datalist, unstyleable (the OS renders it). A change PROPAGATES to every row with the same
  NORMALIZED description (`normalizeDescription`, not "contains"), via a client-side
  `catOverrides` map (normalizedKey→category) applied at render + in the CSV export. Purely
  informative — never affects reconciliation; cleared on a new result. In dev, a row's "AI"
  tag drops once its category is manually edited. The Category column has a fixed
  `min-width` so picking a longer preset doesn't shift the layout; the **Source** column is
  last in both the tables and the CSV.
- **Expense reconciliation** (`expenses.ts`): the user optionally uploads an `expenses.csv`
  (an accounting export: `Supplier, Description, Category, Date, Amount, VAT…`) alongside the
  statements; the app matches each expense to a statement **debit** and reports which are
  found. **`parseExpensesCsv`** is a small quoted-field CSV reader (the codebase had no CSV
  *reader*, only `toCsv`); **`matchExpenses`** pools every account's transactions and matches on a
  **single strict rule, one-to-one**: for each expense with `amount > 0`, an unused debit whose amount
  matches **to the cent** AND whose description **contains the supplier name** (fuzzy `nameMatches`)
  AND whose date is **within ±5 days** (`DEFAULT_WINDOW_DAYS`); `pickBest` breaks ties by closest date.
  **The supplier name is REQUIRED** — this is deliberate: an exact-amount debit alone produces
  coincidental false matches (a €X expense hitting an unrelated €X transfer / ATM withdrawal / a
  different merchant with the same amount). Requiring the name removes those (measured on real data:
  6 wrong "exact" matches eliminated); an expense with no name-confirmed debit is left **not found**
  for the accountant to review (cash / another account / genuinely absent — the not-found list is the
  deliverable). The fuzzy matcher **`nameMatches`** handles the ways a bank line differs from the
  supplier: (a) **truncation/abbreviation** via token-prefix match either direction, ≥4 chars
  ("Screwfix Blanchardstown"→"SCREWFIX", even "SCREW"; "Tool Fix"→"TOOLFIX"); (b) **punctuation/spacing**
  via a word-boundary n-gram on the collapsed form ("B&Q" ↔ "B & Q" → "bq"), which — being a word
  boundary, not a raw substring — avoids "EE" matching inside "coff**ee**"; a `NAME_STOPWORDS` list
  drops generic words that collide across merchants (ltd, service, **station**, **ireland**, insurance,
  motor, direct…) so "Spar … Service **Station**" doesn't match "Circle K Gas **Station**". **Known
  limit:** a supplier name containing a LOCATION can rarely still collide (e.g. "Centra Artane" vs a
  different merchant "… ARTAN" at the same amount+date) — place names are structurally
  indistinguishable from a distinctive brand token (cf. the correct "Richard J Gough"→"R J GOUGH"
  abbreviation), so this is accepted, not special-cased. A matched transaction is tagged `category =
  EXPENSE_CATEGORY` — the string **"Expenses"**, a marker, NOT the expense's own category and
  deliberately NOT a member of `CATEGORIES` — **but only when the row has no category yet**: on
  the PDF path that is every row (matching runs before categorization), while on a re-imported
  CSV/Excel the user's hand-typed categories are real data the marker must not erase (the match is
  still in the report). It is an exported constant rather than a literal
  because the route filters on the same value; two bare literals in two files would drift. The
  returned `ExpenseMatch` records where it matched (date · account · **bank description** ·
  **signed day gap** · **source file+page**). Wired in `app/api/extract/route.ts`
  parallel to `maybeCategorize`: expense matching runs **BEFORE** categorization, and
  `maybeCategorize` then **skips rows already tagged `EXPENSE_CATEGORY`** (`.filter(t => t.category
  !== EXPENSE_CATEGORY)`) — so the marker is never overwritten AND no AI is spent on matched rows.
  The **day gap** (`ExpenseMatch.matchedDayGap`) is the SIGNED difference statement-date minus
  expense-date, from the private `dayOffset` helper — kept separate from `daysBetween`, which stays
  ABSOLUTE because `pickBest` needs a distance while the report needs a direction (a debit dated
  BEFORE its invoice is the case worth reviewing). Added to
  every branch's response as `expenses`; the entries carry the account label
  (`{ tx, account }`) so the report says which account paid, WITHOUT setting `accountLabel` on
  the rows (that would wrongly add an "Account" column to the per-account CSV). UI: an **"+ Add
  expenses"** button (after "+ Add another bank statement") reveals the **"Expenses (CSV)"**
  uploader (a plain link-button, same as "+ Add another bank statement" — the "New" badge and
  info tooltip it once carried were removed). The **Expense
  reconciliation** result section shows a summary "X of Y found" + a
  per-expense table (**Supplier · Category · Date · Amount · Found · Matched · Days · Bank
  description** — the expense's OWN Description is dropped; **Matched shows the account/label
  FIRST, then the date**). **Days** and **Bank description** exist to make a match reviewable
  WITHOUT opening the PDF: the table used to show only *that* something matched, so a coincidental
  same-amount debit at a different merchant was invisible. Days is signed and rendered with an
  explicit `+` on positives (`+2` = the bank posted two days after the invoice, the normal card
  lag); its header carries a native `title` hint — NOT the `.info-tip` bubble, which the cell's
  `overflow: hidden` would clip. The table is
  `table-layout: fixed` with proportional column widths, so long Supplier/Category/Bank-description
  values **truncate with an ellipsis** (full text on the cell's `title`, hover) instead of wrapping.
  The matched debit's **Source (file + page) is NOT shown on screen** — it lives only in the CSV
  export. **CSV export (`expensesReportToCsv`) reproduces the ORIGINAL `expenses.csv` verbatim**
  — every source column in its own order, incl. all VAT columns and the link column under its
  OWN original name — and appends **Found · Matched account · Matched date · Matched description ·
  Days · Source** (account and date stay SEPARATE columns in the export, for spreadsheet use; the
  single "Matched" cell is UI-only, and **Days is written as a plain signed integer** — no `+`
  prefix, ASCII hyphen — so a spreadsheet reads it as a number). Nothing in the source is mutated. To do this,
  `parseExpensesCsv` stores each row's original cells on `Expense.raw` and the original header on
  `Expense.rawHeader`, which travel to the client in the report; the export re-quotes cells via
  `csvCell` (so unnecessary quotes may drop, but values/columns are identical). **Optional "Link"
  column**: some expense exports carry a URL to each expense in an extra column whose name varies —
  `parseExpensesCsv` detects it by a header **containing "link" or "url"** (substring,
  case-insensitive) into `Expense.link`. The **on-screen** report table appends a **"Links"**
  column (short UI header) ONLY when the CSV has usable links; each cell is a hyperlink whose
  visible text is just "Link" (the URL isn't shown), opening in a new tab. The href is sanitised in
  `expenseHref` (app/page.tsx) — only `http(s)://` (or a bare `www.` → `https://`) renders as a
  link, blocking `javascript:`/non-URL values. In the **CSV export** the link is NOT a separate
  appended column — it's simply the original link column, kept under its own name with the full URL.
  Additive: matching runs only when an `expenses.csv` is
  uploaded; it never affects reconciliation, parsers, or the regression fingerprint. Test: `npm
  run test:expenses` (synthetic parse/match/source asserts + fuzzy `nameMatches` + name-tier asserts,
  and a real case `statements/expenses-reconciliation/2/` = BOI×3 + Revolut, **70/109 found** (exact
  amount + name + ≤5 days; manually reviewed — 69 correct, 1 location-word collision, and it recovered
  real matches the old exact-only rule got wrong, e.g. Toolfix). **Each numbered folder under
  `statements/expenses-reconciliation/` is one client** (statements + one `expenses.csv`).
- **Reconciled CSV / Excel re-import** (`csv-import.ts` + `app/import-file.ts`): the user can
  upload a transactions **CSV or Excel workbook** the app EXPORTED earlier to rebuild the
  already-reconciled account(s) — no PDF re-parse, no AI — mainly to reconcile them against an
  `expenses.csv` AFTER typing categories in a spreadsheet, or to re-view / re-export after editing a
  value. **Runs ENTIRELY CLIENT-SIDE**: the pure core is the inverse of `toCsv` /
  `transactionSheet`, and the rebuilt accounts feed the same client-safe `checkReconciliation` /
  `mergeAccounts` / `matchExpenses` — no server route, no network. Scope: only the app's OWN export
  format (columns Account?/#?/Date/Description/Debit/Credit/Balance/Category/Source; third-party/bank
  files with column mapping are a future feature). **Structure**: `parseTransactionRows(rows)` is
  the shared rows-based core (header detection with Account/# optional, `Debit`/`Credit` blank→0,
  `Balance` blank→null, `Source` split back into `sourceFile`/`page`, **statement order restored
  from `#`** — the user may have sorted the file; the running balance is only valid in statement
  order — rows grouped by `Account`: one account or no column → single-statement result, ≥2 →
  multi-account, and each account's **opening/closing DERIVED from the running-balance column**
  robustly to SPORADIC balances: opening anchored at the first printed balance, closing at the last).
  `parseTransactionsCsv(text)` feeds it the quote-aware `parseCsvRows` output and **tolerates what a
  spreadsheet's Save As does to the file** — verified against real Excel 16 output (COM-driven, en-GB;
  fixtures in `scripts/fixtures/`): a UTF-8 **BOM** before the first header cell, **day-first dates**
  (`05/01/2025`, also `dd.mm.yyyy` / `dd-mm-yyyy` in `normalizeDate`), dropped trailing zeros, CRLF,
  and a **`;` list separator with decimal commas** (`parseCsvRows(text, delimiter)` + the
  `decimalComma` option; detected on the header line outside quotes). **Paste from Excel**: the same
  text parser also takes the rows the user copies in Excel (Ctrl+C on the range → **Ctrl+V anywhere on
  the page** in import mode) — Excel puts them on the clipboard as TAB-separated text whose quoting is
  NOT CSV's (measured, fixtures `excel-clipboard-*.tsv`): a cell is quoted ONLY when it holds a tab or a
  newline (inner quotes doubled), while a cell that merely contains quotes — even a LEADING one — is
  emitted raw (`say "hi" now`, `"leading quote`). `parseCsvRows` would drop the quotes of the first and,
  on the second, swallow the rest of the paste into one field, so a tab delimiter routes to
  **`parseTsvRows`**: a `"` is literal unless it opens a cell that either closes with `"`+tab/EOL on the
  same line AND contains a tab, or does not close on the line — a cell spanning lines, told apart from a
  raw leading quote by the COLUMN COUNT (a line already holding as many tab-separated fields as the
  header is a complete row). In `app/page.tsx` a document-level `paste` listener (import mode only,
  not while loading; pastes into `input`/`textarea`/`[contenteditable]` and non-tabular text — no tab
  and a single line — are left to the browser) stores `pastedText`, shown as a "Pasted from Excel — N
  rows" chip with ✕ in place of the file row (one source at a time: a paste drops the file, picking a
  file drops the paste, Clear drops both); "Reconcile file" then calls `parseTransactionsCsv(pastedText)`
  with `PASTED_FILE_NAME` ("pasted-transactions.csv") as the export-name stand-in. `parseTransactionsWorkbook
  (sheets)` takes every sheet as TYPED rows (Date objects → ISO — UTC parts when the reader gave UTC
  midnight; numbers → `#` / money; an Excel serial in the Date column → ISO) and picks the sheet:
  **"Combined"** when present (the multi-account workbook — all rows + Account column; that is where
  the user edits categories), else the single sheet with a Date/Debit/Credit header, else EVERY such
  sheet (a workbook whose Combined was deleted — each account sheet becomes an account labelled by
  its Account column or its sheet name; accounts are never silently dropped); Summary/Expenses
  sheets have no Debit/Credit and are ignored; no candidate → `CSV_IMPORT_BAD_FORMAT`. The browser
  half (`app/import-file.ts`) picks by extension: `.xlsx` → dynamic `import("read-excel-file/
  browser")` (the reading twin of `write-excel-file`, same author, shared `fflate`) with
  `dateFormat: DATE_FORMAT`, everything else → `file.text()`; old binary `.xls` is not offered.
  **What survives the round trip — and why it once didn't**: the user's workflow is reconcile →
  download → type categories in Excel → later re-import + `expenses.csv`, and two things used to
  look "lost": (1) `matchExpenses` OVERWROTE every matched debit's category with the `"Expenses"`
  marker — now the marker is set **only when the row has no category** (on the PDF path that is
  every row, since matching runs before categorization, so nothing changed there); (2) the
  imported file's own name stood in as the rows' source — the per-account breakdown listed
  "export.csv" as the statement, and `transactionSource(t, result.fileName)` put it in cell titles
  and re-exports. Now `statementsFromSources(rows)` rebuilds the **per-statement breakdown from the
  rows' `sourceFile`** (one entry per original PDF: file · transactions · period · balance range
  from that group's running balance) for `fileNames`/`perFile` (single result: shown when ≥2
  sources, like a multi-PDF upload), and an `imported: true` flag on the client result makes
  `sourceFallback` `undefined` — an imported row without a Source has none, never the CSV/xlsx name.
  Export names strip `.pdf|.csv|.xlsx` (`exportBase`), so a re-export of `x.xlsx` isn't
  `x.xlsx-2025.csv`. UI (`app/page.tsx`): the input-source toggle reads **"PDF statements"** vs
  **"Reconciled CSV / Excel"**; the picker accepts `.csv,.xlsx` (`IMPORT_ACCEPT`), the same
  **"+ Add expenses"** uploader applies, and **"Reconcile file"** → `handleImportFile` builds an
  `ApiResponse`-shaped object and `setResult`s it, so the verdict, period bar, combined table,
  filter/sort, per-account & combined CSV/Excel re-export and the expenses report all work
  unchanged. Reconciliation stays a REAL check — a clean export passes, a hand-EDITED file whose
  amounts no longer match the balances FAILS (and `findBalanceBreaks` pinpoints the row). NO changes
  to the route or the core pipeline. Test: `npm run test:csv-import` (CSV round-trip fidelity incl.
  quoted Source, sporadic balances, multi-account split, `#`-reorder, an edited CSV failing,
  no-Balance-column, expense matching over reconstructed accounts, rejecting an `expenses.csv`; the
  Excel-saved CSV fixture (BOM/day-first/dropped zeros); a `;`+decimal-comma CSV; the xlsx round
  trip through `write-excel-file` → `read-excel-file` in Node — single sheet, the full
  Summary/Combined/per-account/Expenses workbook, the no-Combined fallback, sheet-name labels, a
  no-transactions workbook rejected; the Excel-saved `.xlsx` fixture; categories surviving
  `matchExpenses`; `statementsFromSources`; the real Excel clipboard text of an export, and an
  edge fixture for `parseTsvRows` — multi-line cell, raw inner quotes, a cell holding a tab, a raw
  leading quote, doubled quotes + newline).
- **Transaction provenance (Source column)**: each `Transaction` carries an optional
  `page` (1-based PDF page, set by the deterministic parsers — Revolut/AIB/BOI/
  consolidated) and an optional `sourceFile` (set only when several PDFs are combined,
  in `extractAndReconcileMany`). The transaction table and CSV export show a **Source**
  column ("file.pdf, page 23") via `transactionSource(t, fallbackFile)` in
  `verification.ts` — the file falls back to the uploaded name for a single-file run.
  The AI/vision path does NOT set `page` (it works on multi-page chunks), so those rows
  show the file only. These fields are NOT part of the reconciliation or the regression
  fingerprint (which hashes only date/description/debit/credit/balance).
- **CSV "#" (row-order) column**: the UI CSV export (`saveCsv` in `app/save-file.ts` →
  `toCsv` with `rowNumbers: true`) prepends a **"#"** column after Account — the 1-based
  position in statement order — so the user can restore that order after sorting/filtering
  the file elsewhere (the running balance is only valid in statement order; also handy for a
  future re-import of the app's own CSV). UI-export-only: the harness calls `toCsv` WITHOUT
  the flag, so its snapshots stay byte-identical.
- **Exports open a Save As dialog** (`app/save-file.ts`): every "Download CSV" / "Download
  Excel" button (transaction tables, per-account/consolidated tables, expenses report,
  workbook) goes through ONE helper, `saveFile(fileName, kind, produce)`. Where the browser
  has the File System Access API (`window.showSaveFilePicker` — Chrome/Edge desktop) it
  opens a native **Save As** dialog so the user picks the FOLDER and name; the dialog is
  keyed by `id: "statement-exports"`, so the browser reopens it in the LAST folder chosen
  for our exports (CSV and Excel share it — several files of one client land together).
  **The picker opens FIRST and `produce()` builds the bytes only after the user confirms**:
  the dialog must open inside the click's user activation (a few seconds), and building a
  big workbook must never eat into that window (`NotAllowedError`). Cancel saves nothing
  and is not an error (`AbortError` swallowed). Firefox/Safari, or an API that refuses
  (`SecurityError`/`NotAllowedError`), fall back to the classic hidden `<a download>` click
  into the browser's default folder. Browser-only code, so it lives in `app/`, not
  `lib/core/` (`toCsv` stays pure; no DOM in the core).
- **Excel export** (`lib/core/excel.ts` PURE + `app/excel-export.ts` browser wiring): a
  **"Download Excel"** button next to the main table's "Download CSV", and one on the
  consolidated (Revolut Custom) summary card. Why, when CSV exists: Excel mangles our CSV for
  EU users — no BOM → Romanian/Cyrillic descriptions become mojibake, and on a Windows whose
  list separator is `;` (RO/DE/FR locales) every row lands in ONE column. The `.xlsx` opens
  identically everywhere, **dates and amounts are real values** (sortable, summable — Date
  cells at UTC midnight with format `dd/mm/yyyy`, money `#,##0.00`, blank where the CSV is
  blank), the header is bold and frozen, and it holds several sheets, so the whole result is
  **ONE workbook**: single statement → one sheet (the bank); multi-account → `Summary`
  (account · bank · currency · tx · opening · closing · ✓/✗) + `Combined` + one sheet per
  account with transactions, all sliced to the selected financial period like the CSVs;
  consolidated → `Summary` + one sheet per currency account; plus an `Expenses` sheet
  whenever an expenses.csv was reconciled. Columns mirror `toCsv(..., { rowNumbers: true })`
  exactly (Account only when rows carry `accountLabel`, `#`, Date … Source) so the two
  exports never disagree; the Expenses sheet is built from the SAME rows as the CSV
  (`expensesReportRows` in `expenses.ts`, now the single source for `expensesReportToCsv`),
  original columns verbatim as text, only `Days` typed as a number. Sheet names go through
  `sheetName` (Excel rules: no `[]:*?/\`, ≤31 chars, unique). Categories are the EDITED ones,
  as in the CSV. Library: `write-excel-file` (~100 KB, dep `fflate`, ships types) loaded by
  dynamic `import()` on the first click; the core module never imports it — it only emits
  `XlsxSheet` objects whose cell shape (`{ value, type, format, fontWeight }`) the library
  accepts as-is. The per-account CSV buttons are untouched (one table each). Test:
  `npm run test:excel` — pure asserts on the builders + a Node smoke test that the library
  turns them into a ZIP/xlsx buffer; verified on a real BOI statement that the XML carries
  numeric `<v>` cells with the money style, the date as an Excel serial matching the ISO day
  (no timezone drift), and a frozen pane.
- **Per-column sort + filter (BACKLOG 1.3)**: the main single/combined transaction table
  has an Excel/Sheets-style dropdown on each header (**#**, Date, Description, Debit, Credit,
  Balance, Category) — a `<ColumnFilter>` (`app/column-filter.tsx`) whose panel is portalled
  to `<body>` (escaping the table's `overflow: hidden`). Each dropdown offers sort
  (asc/desc) + a type-specific filter: text "contains" (description), value checkboxes with
  select/deselect-all (category), an Excel-style Year→Month→Day checkbox tree (date, built by
  `buildDateTree`), numeric min/max (debit/credit/balance). The **`row` ("#")** column is
  **sort-only** (a `type: "sort"` ColumnFilter — asc/desc, no filter body): it sorts on the
  1-based STATEMENT-ORDER index (`idx` in `applyView`, not a field), so sort-asc restores
  statement order after you've sorted by another column / desc reverses it.
  Filters on different columns combine with **AND**; a single sort key is active at a time.
  The pure logic lives in `app/table-view.ts` (`applyView`, `isColumnActive`,
  `anyFilterActive` + the `ColumnKey`/`Filters`/`SortState` types); `app/page.tsx` holds the
  `filters`/`sort`/`openFilter` state and derives `displayRows` ({ t, idx }) with `useMemo`,
  keeping each row's ORIGINAL index so ids/break-highlight/category-cell/flash stay tied to
  the real row (`#` shows `idx+1`, Balance shows the original value). This is PURELY
  presentational: reconciliation, the verdict, the equation, the balance-break diagnostics
  and the CSV export always use `viewData` (all period rows, original statement order) —
  never `displayRows`. The meta count shows "X of Y transactions" when filtering, with a
  "Clear all filters" button; a discrepancy jump (`jumpToRow`) first clears the view so the
  target row is visible. Distinct from the "Financial period" bar, which re-reconciles a
  date slice. Scope: the main table only (consolidated per-account tables stay unfiltered).
- **Manual verification tick (BACKLOG 2.1, simplified)**: a **"Check mode"** toggle in the meta
  line (off by default — `checkMode` in `app/page.tsx`) reveals a narrow leading checkbox column on
  the main table so the user can mark each row "verified" while checking it against the PDF;
  verified rows get a subtle green wash and a discreet "X of Y verified" counter shows next to the
  toggle. State is a client-side `Set` of ORIGINAL row indices (`verified`), so ticks survive
  filtering/sorting and stay on their rows; session-only (cleared on a new result/period; check
  mode also resets on a new result), purely visual — never touches the data, categories or
  reconciliation. The `.verified-row` style is declared before `.break-row` so a balance-break row
  keeps its warning colour even when ticked.
- **Changelog page** (`app/changelog/page.tsx` + `lib/changelog.ts`): a separate, static
  `/changelog` route listing the app's notable changes, newest first, one card per day (date ·
  title · bullet items). The content is a hand-curated typed array (`CHANGELOG` in
  `lib/changelog.ts`) — DATA, not UI copy, so it lives beside `strings.ts` rather than in it; the
  page's labels (`changelogTitle` / `backToApp` …) are in `strings.ts`. The page is a server
  component (no state, no fetch). The header link to it in `app/page.tsx` renders **only while
  Developer view is on** (`{dev && <Link …>}`) — it is a developer aid, not something accountants
  see; the route itself is open like the rest of the internal tool (there is no auth yet to gate it).
- **Features page** (`app/features/page.tsx` + `lib/features.ts`): the user-facing twin of the
  changelog — a static `/features` route listing **what the app can do**, grouped by task (one
  card per group: title · optional intro · a `<dl>` of feature name → description). Content is a
  hand-curated typed array (`FEATURE_GROUPS`), written for accountants (what it does for them,
  never parser internals). **For now the header link ("Features", beside Changelog) also renders
  only while Developer view is on** — the page is meant for users and will go public later, once
  it is ready to be seen (drop it out of the `{dev && …}` block in `app/page.tsx` at that point;
  Changelog stays dev-only for good). Both sub-pages share the `.subpage` / `.subpage-head` /
  `.subpage-back` chrome and the `.nav-link` header style in `globals.css`. **Convention: every
  new user-visible feature adds/updates an entry in `lib/features.ts` in the same commit** (the
  changelog records WHEN, the features list records WHAT).
- **Recent reconciliations (BACKLOG 5.1, v1 — browser-local)** (`app/recent-store.ts` +
  `app/api-types.ts`): the last **5** reconciliations are saved in the browser and reopened from
  a **"Recent reconciliations"** card under the upload card. First slice of persistence: **no
  accounts, no server** — later versions move the same records to a database. A record is a
  **WORKING SET**: `RecentRecord` = the `ApiResponse` + the user's work on it (category edits
  `catOverrides`, verified ticks `verified` as an array) + a `summary` (verdict / tx / accounts /
  files / period — computed once by `summarize(result, files)`; the verdict reuses the page's own
  rule incl. the crypto-spread "soft" state) + a renamable `name` (defaults to `fileName`; click
  to edit); and `RecentInputs` = everything the upload card held (mode, primary bank + label,
  the PDFs — or the CSV/xlsx / pasted text in import mode — the extra accounts with their PDFs,
  the expenses.csv), files stored as `{ name, type, bytes: ArrayBuffer }` (`toStoredFile` /
  `toFile`). **Storage is IndexedDB, NOT localStorage**: results are ~0.5 MB each for a full
  year and the PDFs are megabytes — localStorage's ~5 MB origin quota could never hold that and a
  `QuotaExceededError` would silently lose the save. One DB `statement-check` (`DB_VERSION` 2),
  **two stores keyed by the same id**: `recent` (record + result + edits — what `listRecent`
  reads with one `getAll`) and `inputs` (the bytes — read ONLY by `loadInputs` when a record is
  opened, so listing never loads PDFs). Hand-written wrapper, no dependency; **every call is
  fail-soft** (private mode / blocked storage → empty list, no-op saves, never a UI error).
  **Saving** (`publishRecent` in `page.tsx`, right after each `setResult` for PDF checks AND
  CSV/Excel re-imports; `collectInputs` reads the bytes AFTER the result, never delaying the
  upload): a fresh result becomes a NEW record (trimmed to `RECENT_LIMIT`, oldest dropped with
  its inputs) — **unless the upload card is a saved record's working set** (`rerunId` =
  `currentRecordId` captured at the start of `handleCheck`/`handleImportFile`, i.e. the record
  was opened or just saved and then edited): then the SAME record is **updated in place** —
  result, summary, inputs and `savedAt` refreshed, **name and category edits kept** (they key on
  normalized descriptions, still valid — `keepEditsForRerun` puts the record's SAVED edits into
  `restoreRef` because the in-memory ones were already cleared when the inputs changed),
  **verified ticks cleared** (row indices shift). "Clear" nulls `currentRecordId`, so the next
  run is a new record. A note under Reconcile (`recentRerunNote`) says which record the next run
  will update. **Opening a record** rebuilds the upload card from `loadInputs` (mode, bank via
  `updateSettings`, labels, files as `File`s, extra accounts with fresh ids, expenses) — a record
  saved before inputs were stored opens with an EMPTY card (the result render is gated on
  `result.data/multi/consolidated`, not on attached files) — then restores the result with its
  edits/ticks through **`restoreRef`**: the two existing `[result]` effects clear `verified` /
  `catOverrides` on every new result, so each consumes its half of the ref instead when set.
  **The PDF pickers APPEND** (`addFiles`: dedupe on name+size; ✕ removes) instead of replacing
  the list — so one more statement can be added to a reopened record (and picked from several
  folders); the single-file pickers (CSV import, expenses) still replace. **Autosave**: an effect
  on `[currentRecordId, result, catOverrides, verified]` debounces 400 ms and `updateRecent`s the
  current record — a no-op while `currentRecordId` is null OR **`result` is null** (editing the
  working set resets the result, which clears the in-memory edits; without the guard an empty
  save would erase the record's edits before the re-run could carry them forward). **Race
  guard**: `currentRecordId` is nulled SYNCHRONOUSLY at the start of `handleCheck` /
  `handleImportFile` / `clearAll`, so the wipe a new result triggers never lands on the previous
  record. Removing the current record keeps the result on screen, it just stops autosaving.
  Views (Financial period, filters/sort, check-mode toggle) are NOT saved. The response
  interfaces moved from `page.tsx` to `app/api-types.ts` (pure move) so the store can type what
  it saves without importing a page file. No migration layer: bump `DB_VERSION` when the shape
  changes (a stale record can simply be removed from the card). Inspect in DevTools →
  Application → IndexedDB → `statement-check` → `recent` / `inputs`.

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
- **Reconciliation is ground truth, not a box to tick.** Extract faithfully; never
  back-compute amounts from the running balance to force a pass (that masks the very
  errors reconciliation exists to catch). Flag bank-side inconsistencies (e.g.
  crypto spreads) rather than auto-correcting amounts.
- **Keep docs in sync.** When you change behavior (parsers, reconciliation,
  pipeline, UI, config), update this file AND `WORKFLOW.md` in the SAME change.
  **`WORKFLOW.md` is the working playbook + bank-parser reference — read it before
  any parser/extraction work, especially in a fresh session.** A notable, user-visible
  change also gets an item in `lib/changelog.ts` (the in-app `/changelog` page) in the
  same change — one plain sentence under that day's entry — and a NEW user-visible
  feature also adds/updates its entry in `lib/features.ts` (the `/features` page).
- **After a parser change, offer the regression harness.** When you create or modify
  a parser, ask whether to run `npm run test:statements -- <bank>` and report the diff
  vs the saved baseline BEFORE committing. The harness (`scripts/test-statements.mts`)
  runs real statements through the production path and flags any reconciliation OR
  content change; data (PDFs in `statements/`, results in `.reconcile/`) is gitignored.
  Each accepted statement also gets a human-readable CSV snapshot of its rows
  (`.reconcile/snapshots/<key>.csv`); on a `CHANGED-*` the run prints the row-level diff
  vs that snapshot, so you see WHAT changed. Each run also writes a colour-coded,
  filterable HTML report (`.reconcile/report.html`, open with `npm run test:report` or the
  `--open` flag) — a dev/local artifact only, nothing in `app/`. See `WORKFLOW.md` →
  "Regression harness".
- **Performance baseline (`npm run test:perf`).** The timing counterpart to the
  regression harness: `scripts/test-perf.mts` times the DETERMINISTIC path
  (`extractAndReconcile`, no AI) on a few representative real statements and flags any
  speed regression (>25% AND >50ms slower) vs a saved baseline
  (`.reconcile/perf-baseline.json`, gitignored — timings are machine-specific, so the
  baseline is per-machine, not committed). First run writes the baseline; `-- --update`
  rewrites it. Reconciliation must still pass (a `RECON-FAIL` fails the run). Reference
  numbers (warm, local): Revolut full-year ≈3170 tx ~5.3s (heaviest, dominated by tx
  count); BOI 320 tx ~0.4s; typical sub-500-tx statements are sub-second. Extraction is
  the only speed-critical path — the UI/route work (period slicing, `#` column,
  sort/filter, `stampBank`) sits outside it and does not affect these numbers.
- **Concise chat replies.** Keep prose responses in chat short and to the point.
  This applies ONLY to chat — code, diffs, and documentation are never shortened
  for the sake of brevity.
- **Never commit automatically — ask first.** Do not run `git commit` (or push)
  on your own; propose the change and wait for explicit approval each time, even
  if a previous commit was approved.
