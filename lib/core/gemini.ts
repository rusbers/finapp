/**
 * Gemini provider — the Gemini-specific implementation of extraction.
 * One of potentially several providers (OpenAI, etc. could be added as siblings).
 * The orchestrator in extraction.ts chooses which provider to use.
 *
 * Runs ONLY on the server (the API key never reaches the browser).
 */

import type { StatementData } from "./types"

const REQUEST_TIMEOUT_MS = 300_000 // 5 min safety net for large PDFs

// Automatic retry with exponential backoff for transient failures.
const MAX_ATTEMPTS = 4 // 1 initial try + 3 retries
const BASE_BACKOFF_MS = 1_000 // 1s, then 2s, then 4s
// HTTP statuses worth retrying (transient server-side / rate-limit issues).
// NOT retried: 400 (bad request), 401/403 (auth) — those won't fix themselves.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PROMPT = `You are a bank statement data extraction system.
Analyze this bank statement and return STRICTLY a single JSON object,
with no text before or after, no explanations.

Exact structure:
{
  "bank": "bank name",
  "openingBalance": number,
  "closingBalance": number,
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "text", "debit": number, "credit": number, "balance": number or null }
  ]
}

RULES:
- "debit" = money OUT of the account (payments, withdrawals). Positive number.
- "credit" = money INTO the account (deposits, incoming). Positive number.
- If a transaction is debit only, set credit = 0. If credit only, set debit = 0.
- "balance" = the running balance shown for that row. If the statement shows no
  running balance column, set balance = null. Do NOT compute it yourself; only
  copy the value printed on the statement.
- Decimal separator is a DOT (1234.56), never a comma.
- Dates in YYYY-MM-DD format.
- openingBalance = balance at the start of the period (opening / brought forward).
- closingBalance = balance at the end of the period (closing / carried forward).
- CRITICAL: list the transactions in the EXACT SAME ORDER they appear on the
  statement, top to bottom, page by page. Do NOT sort or reorder them (not by
  date, not alphabetically, not by amount). Preserve the original order exactly.
- Include ALL transactions, from all pages.`

/** Safely extract the JSON object from a response that may have text around it. */
export function safeParseJson(text: string): StatementData {
  if (!text) throw new Error("Empty response from model")
  let t = text.trim()
  t = t
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON found in response")
  return JSON.parse(t.slice(start, end + 1)) as StatementData
}

/** A non-retryable error: failing again won't help (bad request, auth, etc.). */
class FatalGeminiError extends Error {}

/** One attempt: send the request, return parsed data, or throw. */
async function attemptExtraction(
  url: string,
  apiKey: string,
  payload: unknown,
): Promise<StatementData> {
  // Abort the request if Gemini takes too long, so it fails cleanly
  // instead of hanging the user's request indefinitely.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (e) {
    // Timeouts and network errors are transient → let the retry loop handle them.
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("Gemini request timed out")
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const details = await res.text()
    const message = `Gemini error (${res.status}): ${details.slice(0, 300)}`
    // Non-retryable statuses fail immediately; retryable ones throw a plain
    // Error so the retry loop will try again.
    if (!RETRYABLE_STATUSES.has(res.status)) throw new FatalGeminiError(message)
    throw new Error(message)
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  return safeParseJson(text)
}

/** Send the PDF (as base64) to Gemini and return structured data, with retries. */
export async function extractWithGemini(pdfBase64: string, model: string): Promise<StatementData> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable")

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` + `${model}:generateContent`

  const payload = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0, // deterministic
      responseMimeType: "application/json", // ask for clean JSON directly
      // Disable "thinking" — we want direct extraction, not reasoning.
      // Thinking mode can make the model very slow on long statements.
      thinkingConfig: { thinkingBudget: 0 },
    },
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptExtraction(url, apiKey, payload)
    } catch (e) {
      // Don't retry errors that won't fix themselves (auth, bad request).
      if (e instanceof FatalGeminiError) throw e
      lastError = e
      // If we have attempts left, wait (1s, 2s, 4s…) then try again.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
      }
    }
  }
  // All attempts exhausted.
  throw lastError instanceof Error ? lastError : new Error("Gemini request failed after retries")
}
