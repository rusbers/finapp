/**
 * The app's feature list — what a user can do here, grouped by task.
 *
 * This is DATA, not UI copy (the page's labels live in `strings.ts`). Written for
 * accountants, not developers: say what the app does for them, never how a parser
 * works. Rendered by `app/features/page.tsx`; the header link sits behind Developer
 * view for now (the page goes public once it is ready to be seen).
 *
 * Convention: every new user-visible feature adds or updates an entry here in the
 * same commit (the changelog in `changelog.ts` records WHEN; this records WHAT).
 */

export type Feature = {
  name: string
  description: string
}

export type FeatureGroup = {
  title: string
  intro?: string
  features: Feature[]
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    title: "Reconcile bank statements",
    intro:
      "Upload PDF bank statements and get every transaction as structured data, checked by reconciliation.",
    features: [
      {
        name: "PDF upload",
        description: "One or many statements at once, up to 15 MB each.",
      },
      {
        name: "Automatic reconciliation",
        description:
          "For every statement the app checks opening balance + credits − debits = closing balance (to within 2 cents) and shows a clear pass / fail verdict. An amber verdict marks an out-of-balance fully explained by a known bank-side quirk (e.g. Revolut crypto spreads).",
      },
      {
        name: "Supported banks",
        description:
          "AIB, Bank of Ireland, permanent tsb and Revolut (personal statements, multi-currency bundles and consolidated \"Custom\" statements) are read exactly from the PDF. Any other bank — and scanned statements — are read by AI and still reconciled.",
      },
      {
        name: "Encrypted PDFs",
        description: "Password-protected exports such as Bank of Ireland's open directly.",
      },
      {
        name: "Clear and Cancel",
        description: "Start over without a refresh, or stop a run that is in progress.",
      },
    ],
  },
  {
    title: "Several statements of one account",
    intro: "Upload all the monthly statements of an account together.",
    features: [
      {
        name: "Chained into one series",
        description:
          "Statements are ordered by date and joined into one continuous transaction list, reconciled from the first opening to the last closing balance.",
      },
      {
        name: "Missing statements flagged",
        description:
          "A gap is reported when the balances don't carry over from one statement to the next, or when a whole period is missing between them.",
      },
      {
        name: "Duplicates detected",
        description: "The same statement uploaded twice (even under another name) is excluded and reported.",
      },
      {
        name: "Per-statement breakdown",
        description: "Each file with its transaction count, period and balance range.",
      },
    ],
  },
  {
    title: "Several bank accounts of one client",
    features: [
      {
        name: "Add another bank statement",
        description:
          "Add as many accounts as the client holds, each with its own bank, an optional label and its own PDFs.",
      },
      {
        name: "Independent reconciliation",
        description: "Every account is reconciled on its own; the overall verdict is that all of them balance.",
      },
      {
        name: "Combined table",
        description: "All accounts in one chronological table with an Account column, exportable together or per account.",
      },
    ],
  },
  {
    title: "Check the result",
    features: [
      {
        name: "Running balance",
        description: "Every row shows the balance after it, exactly as on the statement.",
      },
      {
        name: "Discrepancy pinpointed",
        description:
          "When a statement doesn't balance, the app names the exact row where the running balance breaks and links you to it; a floating navigator steps through all discrepancies.",
      },
      {
        name: "Source column",
        description: "Which file and page each transaction came from, so you can check it against the PDF.",
      },
      {
        name: "Check mode",
        description: "Tick each row as you verify it against the statement; a counter shows how many are done.",
      },
      {
        name: "Financial period",
        description:
          "Slice the result to a year or a date range: the period is re-reconciled on its own and every export follows it.",
      },
    ],
  },
  {
    title: "Work with the table",
    features: [
      {
        name: "Sort and filter per column",
        description:
          "Spreadsheet-style menus on every column: text search on descriptions, amount ranges, a year → month → day picker on dates, value checkboxes on categories. Filters combine.",
      },
      {
        name: "Statement order",
        description: "The \"#\" column keeps the original order, so you can always restore it after sorting.",
      },
    ],
  },
  {
    title: "Categories",
    features: [
      {
        name: "Automatic categorization",
        description:
          "Optional: each transaction gets a category from a fixed list — keyword rules first, AI only for what the rules don't catch.",
      },
      {
        name: "Edit a category",
        description:
          "Click a category to pick another or type your own; the change applies to every row with the same description.",
      },
    ],
  },
  {
    title: "Expenses",
    features: [
      {
        name: "Match an expenses file",
        description:
          "Upload an expenses.csv (supplier, date, amount…) alongside the statements; each expense is matched to a statement debit by exact amount, supplier name and a date within 5 days.",
      },
      {
        name: "Found / not-found report",
        description:
          "For each expense: whether it was found, on which account and date, the bank's description and the day gap — so a match is reviewable without opening the PDF. Unmatched expenses are the list to review.",
      },
      {
        name: "Report export",
        description: "The report as CSV, with every original column of your expenses file kept intact.",
      },
    ],
  },
  {
    title: "Export",
    features: [
      {
        name: "CSV",
        description: "Transactions with Account, #, Date, Description, Debit, Credit, Balance, Category and Source columns.",
      },
      {
        name: "Excel workbook",
        description:
          "One .xlsx per result — Summary, Combined, one sheet per account and Expenses — with real dates and amounts (sortable, summable) and a frozen header.",
      },
      {
        name: "Save As",
        description: "Exports open a Save As dialog so you choose the folder; it reopens where you last saved.",
      },
    ],
  },
  {
    title: "Recent reconciliations",
    intro: "The last 5 reconciliations are kept in this browser, so closing the tab no longer loses your work.",
    features: [
      {
        name: "Saved automatically",
        description:
          "Every reconciliation (PDF or re-imported file) is saved on this device — the statements themselves, the result, your category edits and your verified ticks, which keep saving as you work. If the browser cannot store it, the reconciliation still completes and a note tells you it was not saved.",
      },
      {
        name: "Reopen, rename, remove",
        description:
          "Open a saved reconciliation exactly as you left it — statements attached, result shown; click its name to give it the client's name; remove it when done. Only the last 5 are kept.",
      },
      {
        name: "Add or remove statements later",
        description:
          "On an opened reconciliation, attach one more statement (or another account, or an expenses file), remove one with ✕, and reconcile again — the saved entry is updated in place, keeping its name and your category edits.",
      },
    ],
  },
  {
    title: "Re-import a previous export",
    features: [
      {
        name: "Load a reconciled CSV or Excel",
        description:
          "Bring back a file the app exported earlier — or paste the rows straight from Excel with Ctrl+V — and it is rebuilt and re-reconciled in the browser: no PDF, no AI.",
      },
      {
        name: "Keep your edits",
        description:
          "Categories you typed in the spreadsheet are kept, and the original file and page of each row survive the round trip.",
      },
      {
        name: "Match against expenses later",
        description: "Re-imported accounts can be matched to an expenses.csv just like a fresh reconciliation.",
      },
    ],
  },
]
