/**
 * All user-facing strings live here, in one place.
 *
 * This is NOT i18n yet — it's just keeping copy organized so that adding
 * translations later is easy. When you do want multiple languages, this object
 * becomes the English ("en") entry and you add other locales alongside it.
 */

export const strings = {
  appName: "App", // TODO: set your app name here once chosen
  pageTitle: "statement check",
  pageSubtitle: "Upload a statement, then verify the extraction and reconciliation one at a time.",

  fileLabel: "Bank statement (PDF)",
  checkButton: "Check statement",
  checkingButton: "Checking…",

  // Test controls
  bankLabel: "Bank",
  primaryModelLabel: "Primary model",
  fallbackModelLabel: "Fallback model",
  enableFallbackLabel: "Use fallback if reconciliation fails",
  modelLiteName: "Flash-Lite (fastest)",
  modelFlashName: "Flash (balanced)",
  modelProName: "Pro (most accurate)",
  resetButton: "Reset to defaults",

  // Balance-based sign corrections
  correctionsHeading: (n: number) =>
    `${n} debit/credit ${n === 1 ? "sign was" : "signs were"} auto-corrected using the running balance:`,

  verdictPass: "Reconciled — balances match",
  verdictFail: "Out of balance — check the extraction",
  noTransactionsNote:
    "No transactions were found. This statement's format may not be recognized by the selected bank's parser (for example a different language or layout). Try the generic/AI option, or check the bank selection.",
  errorTooManyFiles: "Too many files. Please upload fewer statements at once.",
  // Multi-statement (combining several PDFs of the same account)
  perFileHeading: "Statements combined",
  perFileColumns: { file: "File", count: "Transactions", range: "Balance range" },
  gapWarningTitle: "Possible missing statement",
  gapWarningBody:
    "These statements don't link up by balance — one or more statements may be missing from the series. The closing balance of one statement should match the opening balance of the next.",
  chainedOk: "All statements link up by balance",

  eqOpening: "Opening balance",
  eqCredits: "Credits",
  eqDebits: "Debits",
  eqComputed: "Computed",
  eqClosing: "Closing balance",

  // Function returns the formatted difference string.
  discrepancyNote: (amount: string) =>
    `Difference: ${amount} — likely a missing or duplicated transaction, or a misread amount/column.`,

  metaBank: "Bank",
  metaTransactions: "Transactions",
  metaFile: "File",
  metaDuration: "Took",

  downloadCsv: "Download CSV",

  // Extraction trace / model stats
  extractionHeading: "Extraction",
  attemptReconciled: "reconciled",
  attemptFailed: "failed",
  firstTry: "first try",
  fallbackTriggered: "fallback used",

  thDate: "Date",
  thDescription: "Description",
  thDebit: "Debit",
  thCredit: "Credit",
  thBalance: "Balance",

  // Row-by-row balance check messages
  breaksHeading: (n: number) =>
    `${n} row${n === 1 ? "" : "s"} where the running balance doesn't add up — likely where the extraction broke:`,
  breaksNone:
    "Every row's running balance adds up, yet the total is off. The error is likely a missing or extra row the statement's balance can't reveal, or the opening/closing balance.",
  breaksNoBalance:
    "This statement has no running-balance column, so row-by-row checking isn't available.",

  errorNoFile: "No file attached. Please attach a PDF.",
  errorNotPdf: "Only PDF files are accepted.",
  errorTooLarge: "File is too large (max 15 MB).",
  errorGeneric: "Processing failed.",
  errorUnknown: "Unknown error.",
} as const
