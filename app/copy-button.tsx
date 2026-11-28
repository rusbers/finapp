"use client"

import { useEffect, useRef, useState } from "react"
import { strings as s } from "@/lib/strings"
import { copyTable, csvToHtmlTable, csvToTsv } from "./clipboard"

/**
 * "Copy to clipboard" button — the PRIMARY way out of a table (the user pastes into their
 * own reconciliation workbook; the downloads are the quieter links after it). `getCsv`
 * returns the SAME CSV the download writes (the Financial period's rows, never narrowed by
 * the column filters); it runs only on click, and the table goes to the clipboard as
 * tab-separated text plus an HTML table (see `copyTable`), so it pastes into Excel one value
 * per cell with amounts shown as 10000.00. The label briefly confirms.
 */
export function CopyButton({ getCsv }: { getCsv: () => string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onClick = async () => {
    const csv = getCsv()
    const ok = await copyTable(csvToTsv(csv), csvToHtmlTable(csv))
    setStatus(ok ? "copied" : "failed")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setStatus("idle"), 1500)
  }

  return (
    <button type="button" className="copy-button" onClick={() => void onClick()}>
      {status === "copied" ? s.copied : status === "failed" ? s.copyFailed : s.copyToClipboard}
    </button>
  )
}
