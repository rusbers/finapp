"use client"

/**
 * A file input whose status text WE control.
 *
 * A native <input type="file"> prints its own text next to the button — the file
 * name for one file, "3 files" for several — and the browser owns it: it can't be
 * changed, and it goes stale (remove a file from our list below and the input still
 * shows the old name). So the real input is kept hidden and this renders a button
 * plus an "Uploaded N files" status driven by the COUNT the parent passes in — its
 * state, the single source of truth for what is attached.
 *
 * Picking files REPLACES the selection, exactly like the native input did.
 */

import { useRef } from "react"
import { strings as s } from "@/lib/strings"

interface FilePickerProps {
  accept: string
  multiple?: boolean
  disabled?: boolean
  /** Files currently attached, per the parent's state (drives the status text). */
  count: number
  /** Called with the newly picked files (empty when the dialog was cancelled). */
  onChange: (files: File[]) => void
}

export default function FilePicker({ accept, multiple, disabled, count, onChange }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="file-picker">
      <button
        type="button"
        className="file-picker-button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {multiple ? s.chooseFiles : s.chooseFile}
      </button>
      <span className={`file-picker-status ${count > 0 ? "has-files" : ""}`}>
        {count > 0 ? s.filesUploaded(count) : s.noFileSelected}
      </span>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.files ? Array.from(e.target.files) : [])
          // Forget the native selection so picking the SAME file again (after a ✕
          // removal) still fires `change` — the input never fires for an unchanged value.
          e.target.value = ""
        }}
      />
    </div>
  )
}
