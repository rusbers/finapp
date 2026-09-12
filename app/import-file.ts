/**
 * Re-import of a previous export — the BROWSER half: reads the picked file and hands
 * its rows to the pure parsers in `lib/core/csv-import.ts`.
 *
 *   .csv  → the file's text → `parseTransactionsCsv`
 *   .xlsx → every sheet as typed rows (via `read-excel-file`, the reading twin of the
 *           `write-excel-file` our export uses — same author, shared `fflate`) →
 *           `parseTransactionsWorkbook`, which picks the transactions sheet(s)
 *
 * The xlsx library is loaded with a dynamic `import()` on first use, like the writer in
 * `excel-export.ts`, so it never weighs on the page load. Old binary `.xls` files are
 * not supported (the picker doesn't offer them); a stray one falls through to the CSV
 * path and is rejected as "not a transactions file".
 */

import {
  parseTransactionsCsv,
  parseTransactionsWorkbook,
  type ImportedStatement,
} from "@/lib/core/csv-import"
import { DATE_FORMAT } from "@/lib/core/excel"

/** True for the Excel workbook the app exports (or one the user saved from Excel). */
export function isXlsxFile(file: File): boolean {
  return /\.xlsx$/i.test(file.name)
}

/** Parse a picked CSV / Excel export into one `ImportedStatement` per account.
 * Throws the `CSV_IMPORT_*` error messages of the core parsers. */
export async function readTransactionsFile(file: File): Promise<ImportedStatement[]> {
  if (isXlsxFile(file)) {
    const { default: readXlsxFile } = await import("read-excel-file/browser")
    // `dateFormat` names the format our own writer stamps on date cells, so they come
    // back as Date objects even if the library didn't recognise it on its own; cells
    // Excel formatted itself (a date the user typed) are detected by the library.
    const sheets = await readXlsxFile(file, { dateFormat: DATE_FORMAT })
    return parseTransactionsWorkbook(sheets.map((s) => ({ name: s.sheet, rows: s.data })))
  }
  return parseTransactionsCsv(await file.text())
}
