/**
 * Hand a file (the CSV and Excel exports) to the user — ONE place for every "Download"
 * button: the transaction tables, the expenses report, the Excel workbook.
 *
 * Where the browser supports it (Chrome/Edge on desktop), this opens a native **Save As**
 * dialog via the File System Access API, so the user picks the folder and the name. The
 * dialog is keyed by `id`, which makes the browser reopen it in the LAST folder chosen for
 * our exports — several files of one client land in the same place without re-navigating.
 * Cancel in the dialog saves nothing and is not an error.
 *
 * The picker is opened FIRST and the bytes are produced AFTER the user has picked: the
 * dialog must open inside the click's user activation (a few seconds), and building a big
 * Excel workbook — or even a large CSV — must never eat into that window.
 *
 * Browsers without the API (Firefox, Safari) fall back to the classic hidden
 * `<a download>` click: the file goes to the browser's default download folder, as before.
 * That fallback is also taken if the API is present but refuses (a blocked embedded
 * context, lost user activation), so an export never silently fails.
 *
 * Browser-only code — it lives in `app/`, not in the framework-agnostic `lib/core/`.
 */

import type { StatementData } from "@/lib/core/types"
import { toCsv } from "@/lib/core/verification"

/** Minimal typing of `window.showSaveFilePicker` — TypeScript's DOM lib has no
 * File System Access API types, and we only use this slice of it. */
type SaveFilePicker = (options: {
  suggestedName?: string
  id?: string
  startIn?: "downloads" | "documents" | "desktop"
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<{
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>
}>

export type FileKind = "csv" | "xlsx"

/** What the Save As dialog offers per kind (its file-type filter) and the blob's MIME. */
const KINDS: Record<FileKind, { description: string; mime: string; extension: string }> = {
  csv: { description: "CSV", mime: "text/csv;charset=utf-8;", extension: ".csv" },
  xlsx: {
    description: "Excel workbook",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
}

/** Save the file `produce()` yields as `fileName` — Save As dialog where available, plain
 * download otherwise. `produce` runs only once the user has confirmed the dialog. */
export async function saveFile(
  fileName: string,
  kind: FileKind,
  produce: () => Blob | Promise<Blob>,
): Promise<void> {
  const { description, mime, extension } = KINDS[kind]
  const picker = (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker

  if (picker) {
    try {
      // Must run inside the click's user activation: callers invoke this straight from
      // onClick and this is the first await, so the dialog opens within the gesture.
      const handle = await picker({
        suggestedName: fileName,
        id: "statement-exports",
        startIn: "downloads",
        types: [{ description, accept: { [mime.split(";")[0]]: [extension] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(await produce())
      await writable.close()
      return
    } catch (err) {
      // The user closed the dialog — nothing to save, nothing to report.
      if (err instanceof Error && err.name === "AbortError") return
      // Anything else (SecurityError / NotAllowedError…): fall through to the download.
    }
  }

  const url = URL.createObjectURL(await produce())
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** Save `text` as a CSV file. */
export function saveTextFile(text: string, fileName: string): Promise<void> {
  return saveFile(fileName, "csv", () => new Blob([text], { type: KINDS.csv.mime }))
}

/** Save a statement as CSV. The UI export always includes the "#" (statement-order)
 * column so the order can be restored after editing the file. */
export function saveCsv(data: StatementData, fileName: string, defaultSource?: string): Promise<void> {
  return saveTextFile(toCsv(data, { defaultSource, rowNumbers: true }), fileName)
}
