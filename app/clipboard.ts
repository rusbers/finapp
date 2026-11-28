/**
 * Copy a table to the clipboard so it pastes straight into Excel — the "Copy to clipboard"
 * button next to every "Download CSV".
 *
 * The copy is built FROM the exact CSV the download writes (re-read with the shared CSV
 * reader), so the two can never disagree in columns, order or values. It goes on the
 * clipboard in TWO flavours:
 * - text/plain: tab-separated rows (Excel splits pasted text on tabs and newlines; a tab or
 *   line break inside a cell is flattened to a space to keep the row whole). Notepad and the
 *   app's own Ctrl+V re-import read this one.
 * - text/html: the same table as HTML, which Excel prefers when present. Debit / Credit /
 *   Balance cells carry Excel's `mso-number-format:"0.00"`, so they paste as NUMBERS shown
 *   as 10000.00 / 45.20 — plain text would land in General format (10000, 45.2).
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

/** Columns pasted as 2-decimal numbers (matched on the header, case-insensitive). */
const MONEY_COLUMNS = new Set(["debit", "credit", "balance"])
/** Excel's HTML number format for them: two decimals, no thousands separator. */
const MONEY_STYLE = `mso-number-format:"0\\.00"`

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Our comma CSV → an HTML table for Excel: header row plain, money cells styled. */
export function csvToHtmlTable(csv: string): string {
  const [header = [], ...rows] = parseCsvRows(csv)
  const money = header.map((h) => MONEY_COLUMNS.has(h.trim().toLowerCase()))
  const tr = (cells: string[], isHeader: boolean) =>
    "<tr>" +
    cells
      .map((cell, i) => {
        const text = escapeHtml(cell.replace(/[\t\r\n]+/g, " "))
        const style = !isHeader && money[i] && cell.trim() !== "" ? ` style='${MONEY_STYLE}'` : ""
        return `<td${style}>${text}</td>`
      })
      .join("") +
    "</tr>"
  return (
    `<html><head><meta charset="utf-8"></head><body><table>` +
    [tr(header, true), ...rows.map((r) => tr(r, false))].join("") +
    `</table></body></html>`
  )
}

/**
 * Put a table on the clipboard as plain text AND HTML. The primary path is a synchronous
 * `execCommand("copy")` whose `copy` event we fill ourselves — it writes the HTML as-is
 * (the async Clipboard API may sanitize it and drop the non-standard `mso-` style). Where
 * that is unavailable or refused, fall back to plain text via the async API. True on success.
 */
export async function copyTable(tsv: string, html: string): Promise<boolean> {
  let filled = false
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData("text/plain", tsv)
    e.clipboardData.setData("text/html", html)
    e.preventDefault()
    filled = true
  }
  document.addEventListener("copy", onCopy)
  try {
    if (document.execCommand("copy") && filled) return true
  } catch {
    // fall through to the async API
  } finally {
    document.removeEventListener("copy", onCopy)
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tsv)
      return true
    }
  } catch {
    // nothing left to try
  }
  return false
}
