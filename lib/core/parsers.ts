/**
 * Registry of deterministic per-bank parsers.
 *
 * For banks with a deterministic parser (reads the PDF's text positions and maps
 * values to columns), we use it instead of AI extraction: it's 100% accurate and
 * consistent on that bank's fixed layout. Banks without a parser fall back to AI
 * extraction in the pipeline.
 *
 * To add a bank: write its parser (like revolut-parser.ts), add one entry here, and
 * register it in the regression harness (`BANKS` in scripts/test-statements.mts) so its
 * statements are covered. Only banks with a deterministic parser are tested.
 */

import type { StatementData } from "./types"
import type { BankId } from "./prompts"
import { parseRevolut } from "./revolut-parser"
import { parseAib } from "./aib-parser"
import { parseBoi } from "./boi-parser"

/** A deterministic parser: PDF bytes -> structured statement data. */
export type BankParser = (pdfBytes: Uint8Array) => Promise<StatementData>

/** Banks that have a deterministic parser. Others use AI extraction. */
const PARSERS: Partial<Record<BankId, BankParser>> = {
  revolut: parseRevolut,
  aib: parseAib,
  boi: parseBoi,
}

/** Returns the deterministic parser for a bank, or undefined if none exists. */
export function getParser(bank: BankId): BankParser | undefined {
  return PARSERS[bank]
}

/** Whether a bank has a deterministic parser (so we skip AI for it). */
export function hasParser(bank: BankId): boolean {
  return bank in PARSERS
}
