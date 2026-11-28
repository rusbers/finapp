"use client"

import { useEffect, useRef, useState } from "react"
import { strings as s } from "@/lib/strings"
import { copyText, csvToTsv } from "./clipboard"

/**
 * "Copy to clipboard" link-button that sits next to a "Download CSV". `getCsv` returns the
 * SAME CSV the download writes; it runs only on click (like the downloads), and the
 * table is copied tab-separated for pasting into Excel. The label briefly confirms.
 */
export function CopyButton({ getCsv }: { getCsv: () => string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onClick = async () => {
    const ok = await copyText(csvToTsv(getCsv()))
    setStatus(ok ? "copied" : "failed")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setStatus("idle"), 1500)
  }

  return (
    <button type="button" className="link-button" onClick={() => void onClick()}>
      {status === "copied" ? s.copied : status === "failed" ? s.copyFailed : s.copyToClipboard}
    </button>
  )
}
