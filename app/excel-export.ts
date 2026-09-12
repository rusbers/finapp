/**
 * Excel export — the BROWSER half: feeds the pure sheets from `lib/core/excel.ts` to the
 * xlsx library and hands the workbook to the Save As helper.
 *
 * The library (`write-excel-file`, ~100 KB) is loaded with a dynamic `import()` on the
 * first click, so it never weighs on the page load. Its cell/sheet shapes are exactly what
 * `lib/core/excel.ts` produces, so this is a one-line mapping.
 */

import type { XlsxSheet } from "@/lib/core/excel"
import { saveFile } from "./save-file"

/** Build a workbook (one tab per sheet, in order) and save it as `fileName`. */
export function saveWorkbook(fileName: string, sheets: XlsxSheet[]): Promise<void> {
  return saveFile(fileName, "xlsx", async () => {
    const { default: writeExcelFile } = await import("write-excel-file/browser")
    return writeExcelFile(
      sheets.map((s) => ({
        data: s.rows,
        sheet: s.name,
        columns: s.columns,
        stickyRowsCount: s.stickyRowsCount,
      })),
    ).toBlob()
  })
}
