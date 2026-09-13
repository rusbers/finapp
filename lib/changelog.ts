/**
 * The app's changelog — hand-curated, newest first.
 *
 * This is DATA, not UI copy (labels for the page live in `strings.ts`). Only notable,
 * user-visible changes go here — one entry per day, one plain sentence per item.
 * Rendered by `app/changelog/page.tsx`; the link to it shows only in Developer view.
 *
 * Convention: when you ship a notable change, add an item to the entry for that day
 * (create the day if missing) in the same commit.
 */

export type ChangelogEntry = {
  date: string // ISO yyyy-mm-dd
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-09-13",
    title: "Paste from Excel, Features and Changelog pages",
    items: [
      "Re-import: select the rows in Excel, copy, and press Ctrl+V anywhere on the page — no file needed.",
      "Features page (header link) listing what the app can do, grouped by task; and this Changelog page, linked in Developer view.",
    ],
  },
  {
    date: "2026-09-12",
    title: "Excel export, Save As dialog, Clear / Cancel",
    items: [
      "Excel export: one .xlsx workbook per result (Summary, Combined, one sheet per account, Expenses) with real dates and amounts.",
      "CSV and Excel exports open a native Save As dialog so you pick the folder; it reopens in the last folder used.",
      "Re-import accepts .xlsx workbooks and keeps hand-typed categories and each row's original Source.",
      "Clear and Cancel sit in one slot beside Reconcile; Cancel also stops the in-flight AI calls on the server.",
      "Consolidated (Revolut Custom) result: the summary's account names jump to each account table and back.",
      "File inputs show an \"Uploaded N files\" status that stays in sync when a file is removed.",
    ],
  },
  {
    date: "2026-09-10",
    title: "PTSB descriptions, expense report details",
    items: [
      "PTSB hybrid parser: numbers stay deterministic (digit cipher solved from balance arithmetic), descriptions are read from the rendered pages by AI — one page per call, with a stronger-model retry for badly read pages.",
      "Revolut consolidated: the ro-md template's transaction-section title is recognised (was reported as \"nothing in scope\").",
      "Expense report shows the matched bank description and the signed day gap, so a match is reviewable without opening the PDF.",
    ],
  },
  {
    date: "2026-09-08",
    title: "Revolut narrow template",
    items: [
      "Revolut: the narrower 560pt page template is parsed (previously 0 transactions), and separate-account sections no longer truncate the rest of the statement.",
    ],
  },
  {
    date: "2026-07-17",
    title: "CSV re-import, # column, per-account periods",
    items: [
      "Re-import a transactions CSV this app exported earlier — rebuilt and re-reconciled entirely in the browser, no PDF re-parse, no AI.",
      "The Account column is always shown, and a \"#\" statement-order column lets you restore the original order after sorting elsewhere.",
      "Financial period slices and re-reconciles each account in multi-account mode.",
      "Expense matching requires the supplier name (exact amount + name + ±5 days) — removes coincidental same-amount matches.",
      "Performance baseline harness (npm run test:perf) guards the deterministic path's speed.",
    ],
  },
  {
    date: "2026-07-13",
    title: "Expense reconciliation",
    items: [
      "Upload an expenses.csv alongside the statements: each expense is matched to a statement debit, with a found / not-found report and CSV export.",
      "Gemini Pro option removed; the model list is Flash-Lite + Flash.",
    ],
  },
  {
    date: "2026-07-12",
    title: "Multiple bank accounts",
    items: [
      "\"+ Add another bank statement\": several accounts per client, each reconciled independently, with a combined table carrying an Account column.",
      "Multi-PDF statements are ordered chronologically (not by balance chain) and gap detection is corrected accordingly.",
    ],
  },
  {
    date: "2026-07-01",
    title: "Category editing, column filters, check mode",
    items: [
      "Inline category editing via a combobox; a change applies to every row with the same description.",
      "Excel-style per-column sort and filter on the transaction table.",
      "Check mode: tick each row as verified while checking it against the PDF.",
      "Beta badge and a clearer Financial-period control.",
    ],
  },
  {
    date: "2026-06-30",
    title: "Transaction categorization",
    items: [
      "Automatic categorization (keyword rules first, AI only for the rest), behind a toggle.",
      "Files panel lists every uploaded PDF with its data and duplicate / ignored badges.",
    ],
  },
  {
    date: "2026-06-29",
    title: "Source column, duplicates, discrepancy navigator",
    items: [
      "Source column: which file and page each transaction came from (also in the CSV).",
      "Duplicate statements in a multi-PDF upload are detected and excluded, with a warning.",
      "Each balance discrepancy links to its row, plus a floating navigator between discrepancies.",
      "BOI: encrypted PDFs and no-activity months are handled deterministically.",
      "Revolut: glued description+amount tokens and Russian separate-account sections; consolidated statements with joint accounts, and \"no current accounts\" is no longer a failure.",
    ],
  },
  {
    date: "2026-06-28",
    title: "Financial period, Developer view",
    items: [
      "Financial period filter: slice the result to a year or range and re-reconcile it.",
      "Developer-view toggle: a clean production result by default, full detail (equation, trace, corrections) when on.",
      "Multi-file gaps are named by the missing period; false and duplicate gaps fixed.",
      "Floating back-to-top button for long results.",
    ],
  },
  {
    date: "2026-06-27",
    title: "PTSB parser, Revolut multi-period / multi-currency",
    items: [
      "Deterministic PTSB parser: the anti-extraction font's digits are decoded from balance arithmetic.",
      "Revolut: multi-period statements, multi-currency bundles reconciled per currency, vaults and sub-accounts skipped.",
      "Regression harness keeps a CSV snapshot per statement and prints a row-level diff on any change.",
    ],
  },
  {
    date: "2026-06-26",
    title: "Revolut consolidated, regression harness, AI fallback",
    items: [
      "Revolut consolidated (\"Custom\") statements: each current account reconciled separately.",
      "Regression harness over real statements with an HTML report.",
      "When a deterministic parser finds 0 transactions, extraction falls back to AI vision.",
      "BOI glued \"OD\" overdraft balances; AIB \"OPENING BALANCE\" row on loan statements.",
    ],
  },
  {
    date: "2026-06-25",
    title: "Revolut locales and soft verdict",
    items: [
      "Revolut parser reads RO / EN / RU statements and non-euro currencies.",
      "A soft (amber) verdict for an out-of-balance fully explained by a known bank-side inconsistency (e.g. crypto spreads).",
    ],
  },
  {
    date: "2026-06-17",
    title: "Multi-PDF upload",
    items: [
      "Several PDFs of one account are chained by balance, with missing statements flagged.",
      "pdfjs hardened for the serverless runtime.",
    ],
  },
  {
    date: "2026-06-16",
    title: "Deterministic parsers",
    items: [
      "Deterministic parsers for Revolut, AIB and Bank of Ireland, reading the PDF's text positions — exact on the target banks.",
      "Per-bank prompt registry for the AI path.",
    ],
  },
  {
    date: "2026-06-14",
    title: "First version",
    items: [
      "PDF upload, Gemini extraction with page parallelization, integer-cent reconciliation (±2 cents), model cascade, row-by-row running-balance diagnosis, CSV export.",
    ],
  },
]
