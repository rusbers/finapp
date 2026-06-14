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
│   ├── gemini.ts          → Gemini provider: API call, retries, JSON parse (server-only)
│   ├── extraction.ts      → provider-agnostic seam (chooses the provider)
│   ├── pipeline.ts        → extract-and-reconcile cascade + per-model stats
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
- **Reconciliation** in integer cents, tolerance ±2 cents.
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

- A 42-page AIB statement (863 transactions) extracts but failed reconciliation
  by a round 2880.00 on flash — opening/closing balances read correctly, so the
  error is a missing/duplicated/misread transaction. This is the hardest case;
  smaller statements are expected to do better. The row-by-row balance check and
  the flash→pro cascade are the tools to pinpoint/recover such cases.

The reconciliation, cascade, retry, and balance-break logic are all unit-tested.
The live Gemini call is validated on real uploads.

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
