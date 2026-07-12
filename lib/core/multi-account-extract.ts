/**
 * Multi-account reconciliation — SERVER half (orchestration).
 *
 * Given several accounts (each: a bank, an optional label, and 1..N PDFs), it
 * reconciles EACH account independently by dispatching to the existing pipeline
 * entry points, then returns the per-account results. There is NO cross-account
 * logic here (no transfer matching) — the client merges the rows for display.
 *
 * This module imports the server-only pipeline (pdfjs + Gemini), so it must ONLY
 * be imported from the API route — never from a client component. The pure half
 * (`multi-account.ts`) holds the shared types + the browser-safe helpers.
 */

import {
  extractAndReconcile,
  extractAndReconcileMany,
  extractConsolidated,
  extractRevolut,
  type PipelineOptions,
  type MultiPipelineResult,
  type ConsolidatedAccountResult,
} from "./pipeline"
import { SHORT_BANK_LABELS, type BankId } from "./prompts"
import { dedupeLabels, type MultiAccount, type MultiAccountResult } from "./multi-account"
import type { Transaction, PipelineResult } from "./types"

/** One account as uploaded: its bank, an optional user label, and its PDF bytes. */
export interface AccountInput {
  bank: BankId
  label?: string
  files: { name: string; bytes: Uint8Array }[]
}

/** Set `sourceFile` on any row that doesn't already carry one (single-file accounts,
 * where the parser doesn't tag rows). Rows are copied, never mutated. */
function backfillSource(transactions: Transaction[], fileName: string): Transaction[] {
  return transactions.map((t) => (t.sourceFile ? t : { ...t, sourceFile: fileName }))
}

/** Build a MultiAccount from a single-statement pipeline result. */
function accountFromPipeline(
  result: PipelineResult,
  label: string,
  bank: BankId,
  fileNames: string[],
): MultiAccount {
  const transactions = backfillSource(result.data.transactions, fileNames[0] ?? "")
  return {
    label,
    bank,
    transactionCount: transactions.length,
    openingBalance: result.data.openingBalance,
    closingBalance: result.data.closingBalance,
    reconciliation: result.reconciliation,
    transactions,
    fileNames,
  }
}

/** Build a MultiAccount from a multi-file chained result (rows already carry sourceFile). */
function accountFromMany(
  multi: MultiPipelineResult,
  label: string,
  bank: BankId,
  fileNames: string[],
): MultiAccount {
  const data = multi.result.data
  return {
    label,
    bank,
    transactionCount: data.transactions.length,
    openingBalance: data.openingBalance,
    closingBalance: data.closingBalance,
    reconciliation: multi.result.reconciliation,
    transactions: data.transactions,
    fileNames,
    perFile: multi.perFile,
    gaps: multi.gaps,
    fullyChained: multi.fullyChained,
    duplicates: multi.duplicates,
  }
}

/** Build a MultiAccount from one account of a consolidated / multi-currency Revolut
 * result. The account's own label (or currency) is appended so several accounts from
 * ONE upload stay distinct — e.g. "Revolut (EUR)", "Revolut (Cont personal)". */
function accountFromConsolidated(
  a: ConsolidatedAccountResult,
  baseLabel: string,
  fileNames: string[],
): MultiAccount {
  const suffix = a.label || a.currency || "account"
  return {
    label: `${baseLabel} (${suffix})`,
    bank: "revolut",
    currency: a.currency,
    transactionCount: a.transactionCount,
    openingBalance: a.openingBalance,
    closingBalance: a.closingBalance,
    reconciliation: a.reconciliation,
    transactions: backfillSource(a.transactions, fileNames[0] ?? ""),
    fileNames,
  }
}

/** Extract + reconcile ONE uploaded account, dispatching by bank/file-count. May
 * return several accounts (a Revolut bundle split by currency / a consolidated PDF). */
async function extractOneInput(
  input: AccountInput,
  baseLabel: string,
  options: PipelineOptions,
): Promise<MultiAccount[]> {
  const { bank, files } = input
  const fileNames = files.map((f) => f.name)

  // Revolut consolidated ("Custom") — one PDF bundling many accounts.
  if (bank === "revolut-consolidated") {
    const consolidated = await extractConsolidated(files[0].bytes)
    return consolidated.accounts.map((a) => accountFromConsolidated(a, baseLabel, fileNames))
  }

  // Revolut single PDF — may itself be a multi-currency bundle.
  if (bank === "revolut" && files.length === 1) {
    const rev = await extractRevolut(files[0].bytes, { ...options, bank: "revolut" })
    if (rev.kind === "multi") {
      return rev.consolidated.accounts.map((a) => accountFromConsolidated(a, baseLabel, fileNames))
    }
    return [accountFromPipeline(rev.result, baseLabel, bank, fileNames)]
  }

  // Several PDFs of the same account → chain them by balance.
  if (files.length > 1) {
    const multi = await extractAndReconcileMany(files, { ...options, bank })
    return [accountFromMany(multi, baseLabel, bank, fileNames)]
  }

  // Single file, any other bank.
  const result = await extractAndReconcile(files[0].bytes, { ...options, bank })
  return [accountFromPipeline(result, baseLabel, bank, fileNames)]
}

/**
 * Extract + reconcile every account of a client, then label them distinctly.
 *
 * Each account runs concurrently; a failure is re-thrown with the account's label
 * prefixed (so an encrypted PDF in one account gives a clear message, not an opaque
 * 500). Labels default to the bank's short name, are only deduped AFTER any
 * currency split, and the user's label always wins.
 */
export async function extractAccounts(
  inputs: AccountInput[],
  options: PipelineOptions = {},
): Promise<MultiAccountResult> {
  const groups = await Promise.all(
    inputs.map(async (input) => {
      const baseLabel = input.label?.trim() || SHORT_BANK_LABELS[input.bank]
      try {
        return await extractOneInput(input, baseLabel, options)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`${baseLabel}: ${msg}`)
      }
    }),
  )

  const accounts = groups.flat()
  // Disambiguate the display labels across ALL accounts (after currency splits).
  const labels = dedupeLabels(accounts.map((a) => a.label))
  accounts.forEach((a, i) => (a.label = labels[i]))

  const withTx = accounts.filter((a) => a.transactionCount > 0)
  const allReconciled = withTx.length > 0 && withTx.every((a) => a.reconciliation.passed)
  return { accounts, allReconciled }
}
