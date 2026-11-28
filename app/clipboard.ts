/**
 * Copy a table to the clipboard so it pastes straight into Excel — the "Copy to clipboard"
 * button next to every "Download CSV".
 *
 * The copy is built FROM the exact CSV the download writes (re-read with the shared CSV
 * reader), so the two can never disagree in columns, order or values. Excel splits pasted
 * text on tabs and newlines, so the CSV becomes tab-separated rows; a tab or line break
 * inside a cell (a multi-line description) is flattened to a space to keep the row whole.
 *
 * Browser-only code — it lives in `app/`, not in the framework-agnostic `lib/core/`.
 */

import { parseCsvRows } from "@/lib/core/expenses"

/** Our comma CSV → tab-separated rows, one table row per line. */
export function csvToTsv(csv: string): string {
  return parseCsvRows(csv)
    .map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, " ")).join("\t"))
    .join("\n")
}

/** Put `text` on the clipboard. The async Clipboard API needs a secure context; where it
 * is missing or refuses, fall back to the legacy hidden-textarea copy. True on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    ta.remove()
  }
}
