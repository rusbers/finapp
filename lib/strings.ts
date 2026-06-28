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
  verdictSoft: "Out of balance — explained, not an extraction error",
  noTransactionsNote:
    "No transactions were found. This statement's format may not be recognized by the selected bank's parser (for example a different language or layout). Try the generic/AI option, or check the bank selection.",
  errorTooManyFiles: "Too many files. Please upload fewer statements at once.",
  // Multi-statement (combining several PDFs of the same account)
  perFileHeading: "Statements combined",
  perFileColumns: { file: "File", count: "Transactions", period: "Period", range: "Balance range" },
  gapWarningTitle: "Possible missing statement",
  gapWarningBody:
    "These statements don't link up by balance — one or more statements may be missing from the series. The closing balance of one statement should match the opening balance of the next.",
  /** One precise line per gap: which period is missing, with the balance jump. */
  gapMissingPeriod: (beforeEnd: string, afterStart: string, balBefore: string, balAfter: string) =>
    `A statement covering ${beforeEnd} → ${afterStart} appears to be missing: balance jumps from ${balBefore} (closing on ${beforeEnd}) to ${balAfter} (opening on ${afterStart}).`,
  /** Fallback line when we can't date the gap (a statement had no dated rows). */
  gapMissingBalances: (balBefore: string, balAfter: string) =>
    `Balances don't link up: one statement closes at ${balBefore} but the next opens at ${balAfter} — a statement may be missing between them.`,
  chainedOk: "All statements link up by balance",

  // Financial-period filter (slice the result to a year / custom range)
  periodLabel: "Financial period",
  periodAll: "All",
  periodCustom: "Custom…",
  periodCovers: (from: string, to: string) => `Covers ${from} → ${to}`,
  periodEmpty: "No transactions in this period",
  backToTop: "Back to top",

  // Revolut consolidated ("Custom") statement — several current accounts in one PDF
  consolidatedPass: "Reconciled — all accounts match",
  consolidatedFail: "Out of balance — check the accounts below",
  consolidatedHeading: (n: number) => `Consolidated statement — ${n} account${n === 1 ? "" : "s"}`,
  consolidatedColumns: {
    account: "Account",
    count: "Transactions",
    range: "Opening → Closing",
    status: "Reconciled",
  },

  eqOpening: "Opening balance",
  eqCredits: "Credits",
  eqDebits: "Debits",
  eqComputed: "Computed",
  eqClosing: "Closing balance",

  // Function returns the formatted difference string.
  discrepancyNote: (amount: string) =>
    `Difference: ${amount} — likely a missing or duplicated transaction, or a misread amount/column.`,
  // Soft case: the imbalance is fully explained by Revolut's hidden crypto-sell fees.
  discrepancyNoteCrypto: (amount: string, n: number) =>
    `Difference: ${amount} — caused by Revolut's hidden crypto-sell fees on ${n} row${n === 1 ? "" : "s"} (the bank shows the gross crypto value as money in but credits less to the balance). The extracted amounts match the statement exactly — this is the bank's figure, not an extraction error.`,

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
  breaksHeadingCrypto: (n: number) =>
    `${n} crypto-sell row${n === 1 ? "" : "s"} where Revolut credits less than the printed amount (a hidden bank fee), so the running balance differs:`,
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
