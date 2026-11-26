"use client"

/**
 * A file input whose status text WE control — and a drop zone.
 *
 * A native <input type="file"> prints its own text next to the button — the file
 * name for one file, "3 files" for several — and the browser owns it: it can't be
 * changed, and it goes stale (remove a file from our list below and the input still
 * shows the old name). So the real input is kept hidden and this renders a button
 * plus an "Uploaded N files" status driven by the COUNT the parent passes in — its
 * state, the single source of truth for what is attached.
 *
 * Files can also be DRAGGED onto the box. A drop behaves exactly like picking: it
 * REPLACES the selection (as the native input did), keeps only files matching
 * `accept`, and takes just the first one when `multiple` is off. A drop that misses
 * every box is swallowed page-wide (see `useSwallowStrayDrops`), otherwise the
 * browser would navigate to the dropped PDF and the user would lose their work.
 */

import { useEffect, useRef, useState } from "react"
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

/** Does `file` match an `accept` string like "application/pdf" or ".csv,text/csv"?
 *  The native dialog enforces `accept`; a drop doesn't, so we check it ourselves. */
function matchesAccept(file: File, accept: string): boolean {
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return accept
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => {
      if (a.startsWith(".")) return name.endsWith(a)
      if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1))
      // A MIME type — also accept by extension, since some systems report a dragged
      // file's type as "" (then "application/pdf" would reject a real PDF).
      if (a === "application/pdf") return type === a || name.endsWith(".pdf")
      return type === a
    })
}

/** True when the drag carries files (not a text selection or a link). */
function hasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")
}

/** Stop the browser from OPENING a file dropped anywhere outside a picker. Every
 *  picker installs it; the listeners are identical, so several instances are harmless. */
function useSwallowStrayDrops() {
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    window.addEventListener("dragover", swallow)
    window.addEventListener("drop", swallow)
    return () => {
      window.removeEventListener("dragover", swallow)
      window.removeEventListener("drop", swallow)
    }
  }, [])
}

export default function FilePicker({ accept, multiple, disabled, count, onChange }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave also fire when the pointer crosses the box's CHILDREN (button,
  // status), so a plain boolean flickers; count enters minus leaves instead.
  const depth = useRef(0)
  useSwallowStrayDrops()

  const endDrag = () => {
    depth.current = 0
    setDragging(false)
  }

  return (
    <div
      className={`file-picker ${dragging ? "dragging" : ""}`}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault() // required, or the browser refuses the drop
        e.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        endDrag()
        if (disabled) return
        const accepted = Array.from(e.dataTransfer.files).filter((f) => matchesAccept(f, accept))
        // Nothing usable (e.g. a .docx on the PDF box): keep the current selection.
        if (accepted.length === 0) return
        onChange(multiple ? accepted : accepted.slice(0, 1))
      }}
    >
      <button
        type="button"
        className="file-picker-button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {multiple ? s.chooseFiles : s.chooseFile}
      </button>
      <span className={`file-picker-status ${count > 0 ? "has-files" : ""}`}>
        {dragging
          ? s.dropFilesHere(!!multiple)
          : count > 0
            ? s.filesUploaded(count)
            : s.noFileSelected}
      </span>
      {!dragging && !disabled && <span className="file-picker-drop-hint">{s.orDragHere}</span>}
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
