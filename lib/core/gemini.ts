/**
 * Gemini provider — the Gemini-specific implementation of extraction.
 * One of potentially several providers (OpenAI, etc. could be added as siblings).
 * The orchestrator in extraction.ts chooses which provider to use.
 *
 * Runs ONLY on the server (the API key never reaches the browser).
 */

import type { ExtractedChunk } from "./types"

const REQUEST_TIMEOUT_MS = 300_000 // 5 min safety net for large PDFs

// Automatic retry with exponential backoff for transient failures.
const MAX_ATTEMPTS = 4 // 1 initial try + 3 retries
const BASE_BACKOFF_MS = 1_000 // 1s, then 2s, then 4s
// HTTP statuses worth retrying (transient server-side / rate-limit issues).
// NOT retried: 400 (bad request), 401/403 (auth) — those won't fix themselves.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Safely extract the JSON object from a response that may have text around it. */
/**
 * Escape raw control characters (newlines, tabs, etc.) that appear INSIDE JSON
 * string values. Models sometimes emit a literal newline inside a description
 * instead of an escaped \\n, which makes JSON.parse fail. We walk the text and,
 * while inside a quoted string, replace control chars with their escaped form.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      out += ch
      continue
    }
    if (inString) {
      // Replace raw control characters with their valid JSON escape.
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        if (ch === "\n") out += "\\n"
        else if (ch === "\r") out += "\\r"
        else if (ch === "\t") out += "\\t"
        else out += " " // other control chars → space
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * Remove thousands-separator commas inside numbers (e.g. 1,000.00 -> 1000.00).
 * Models sometimes format large numbers with commas, which is invalid JSON.
 * We only strip a comma when it sits between two digits, so structural JSON
 * commas (between fields/array items) are never touched.
 */
function removeThousandsSeparators(json: string): string {
  // Apply repeatedly so numbers with several separators (1,234,567.89) are fully
  // cleaned — each pass removes one comma, overlapping matches need another pass.
  let prev: string
  let out = json
  do {
    prev = out
    out = out.replace(/(\d),(\d{3})/g, "$1$2")
  } while (out !== prev)
  return out
}

export function safeParseJson(text: string): ExtractedChunk {
  if (!text) throw new Error("Empty response from model")
  let t = text.trim()
  t = t
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim()
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON found in response")
  const slice = t.slice(start, end + 1)

  let raw: unknown
  try {
    raw = JSON.parse(slice)
  } catch {
    // Models produce two common JSON-breaking mistakes:
    //   1. raw control chars (e.g. a literal newline) inside string values
    //   2. thousands separators inside numbers (1,000.00 instead of 1000.00)
    // Apply both repairs, then try once more.
    let repaired = escapeControlCharsInStrings(slice)
    repaired = removeThousandsSeparators(repaired)
    try {
      raw = JSON.parse(repaired)
    } catch {
      throw new Error("Model returned invalid JSON (the response may be incomplete).")
    }
  }
  return normalizeChunk(raw)
}

/**
 * Coerce a value to a number, or null if it isn't a usable number.
 * The model is asked for numbers but sometimes returns strings like "123.45"
 * (or "1,234.56"); this guarantees downstream code always sees real numbers.
 */
function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "") // strip currency symbols, commas, spaces
    if (cleaned === "" || cleaned === "-" || cleaned === "+") return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Coerce to a number, defaulting to 0 (for debit/credit which should be numeric). */
function toNumber(value: unknown): number {
  return toNumberOrNull(value) ?? 0
}

/** Normalize a raw model response into a clean ExtractedChunk with proper types. */
function normalizeChunk(raw: unknown): ExtractedChunk {
  const obj = (raw ?? {}) as Record<string, unknown>
  const rawTransactions = Array.isArray(obj.transactions) ? obj.transactions : []

  return {
    bank: typeof obj.bank === "string" ? obj.bank : "",
    openingBalance: toNumberOrNull(obj.openingBalance),
    closingBalance: toNumberOrNull(obj.closingBalance),
    transactions: rawTransactions.map((t) => {
      const tx = (t ?? {}) as Record<string, unknown>
      return {
        date: typeof tx.date === "string" ? tx.date : "",
        description: typeof tx.description === "string" ? tx.description : "",
        debit: toNumber(tx.debit),
        credit: toNumber(tx.credit),
        balance: toNumberOrNull(tx.balance),
      }
    }),
  }
}

/** A non-retryable error: failing again won't help (bad request, auth, etc.). */
class FatalGeminiError extends Error {}

/** One attempt: send the request, return parsed data, or throw. */
async function attemptExtraction(
  url: string,
  apiKey: string,
  payload: unknown,
): Promise<ExtractedChunk> {
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
  const candidate = data?.candidates?.[0]
  const finishReason = candidate?.finishReason
  const text = candidate?.content?.parts?.[0]?.text ?? ""

  // If the model hit the output limit, the JSON is cut off mid-way. Surface a
  // clear, retryable error instead of a cryptic JSON parse failure.
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      "Gemini response was truncated (too many transactions for one chunk). " +
        "This chunk has too much data; consider fewer pages per chunk.",
    )
  }

  return safeParseJson(text)
}

/** Send the PDF (as base64) to Gemini and return structured data, with retries. */
export async function extractWithGemini(
  pdfBase64: string,
  model: string,
  prompt: string,
): Promise<ExtractedChunk> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable")

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` + `${model}:generateContent`

  // "Thinking" mode: we disable it for speed on the lighter models (Flash,
  // Flash-Lite). The Pro model REQUIRES thinking mode (it rejects budget 0),
  // so we leave it on for Pro.
  const supportsDisablingThinking = !model.includes("pro")

  const generationConfig: Record<string, unknown> = {
    temperature: 0, // deterministic
    responseMimeType: "application/json", // ask for clean JSON directly
    maxOutputTokens: 65536, // allow long responses (many transactions)
  }
  if (supportsDisablingThinking) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
        ],
      },
    ],
    generationConfig,
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
