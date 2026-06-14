/**
 * Extraction orchestrator — the provider-agnostic seam.
 * To switch AI provider, change only the function called here (and add the new
 * provider file alongside gemini.ts). Nothing else in the app needs to change.
 */

import type { StatementData } from "./types"
import { extractWithGemini } from "./gemini"

/** Extract structured statement data from a PDF (base64), using the given model. */
export async function extractStatement(pdfBase64: string, model: string): Promise<StatementData> {
  // Current provider: Gemini. Swap this line to change providers.
  return extractWithGemini(pdfBase64, model)
}
