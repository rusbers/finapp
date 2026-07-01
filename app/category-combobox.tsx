"use client"

/**
 * A small, fully-styled category combobox used for inline category editing.
 *
 * Why not a native <select>/<datalist>? The transaction table has `overflow:
 * hidden` (for its rounded corners), which clips any inline dropdown; and a
 * native <datalist> popup can't be styled (the OS renders it — dark, oversized).
 * So the menu is rendered through a PORTAL to <body> and positioned `fixed`
 * under the input, escaping the table's clip while staying on-brand (light).
 *
 * It lets the user PICK from the suggestion list OR TYPE a custom category.
 * Purely a display concern — the caller applies the value; reconciliation is
 * never touched.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { strings as s } from "@/lib/strings"

interface Props {
  /** The current category (shown as placeholder). */
  value: string
  /** Suggestions to offer (fixed list + any custom ones used this session). */
  suggestions: string[]
  /** Commit a picked or typed value. */
  onCommit: (value: string) => void
  /** Close without changing anything (Escape / click outside). */
  onCancel: () => void
}

const MENU_MAX_HEIGHT = 240

export default function CategoryCombobox({ value, suggestions, onCommit, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)

  const q = query.trim().toLowerCase()
  const filtered = q ? suggestions.filter((c) => c.toLowerCase().includes(q)) : suggestions
  const hasExact = suggestions.some((c) => c.toLowerCase() === q)
  const showAdd = q.length > 0 && !hasExact

  // Position the portalled menu under the input (fixed = viewport coords, which
  // match getBoundingClientRect). Flip above when there isn't room below.
  useLayoutEffect(() => {
    const place = () => {
      const el = inputRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const flip = below < MENU_MAX_HEIGHT + 16 && r.top > below
      setPos({
        top: flip ? r.top - 4 : r.bottom + 4,
        left: r.left,
        minWidth: Math.max(r.width, 160),
      })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [])

  // Focus the input on open.
  useEffect(() => inputRef.current?.focus(), [])

  const commitTyped = () => {
    if (filtered.length > 0) onCommit(filtered[active < 0 ? 0 : active])
    else if (q) onCommit(query.trim())
    else onCancel()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      commitTyped()
    } else if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        className="cat-select"
        value={query}
        placeholder={value}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        onBlur={onCancel}
      />
      {pos &&
        createPortal(
          <ul
            className="cat-menu"
            style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.minWidth }}
          >
            {filtered.map((opt, i) => (
              <li
                key={opt}
                className={
                  "cat-opt" +
                  (i === active ? " active" : "") +
                  (opt === value ? " selected" : "")
                }
                // onMouseDown (not onClick) so the input doesn't blur-cancel first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onCommit(opt)
                }}
              >
                {opt}
              </li>
            ))}
            {showAdd && (
              <li
                className="cat-opt cat-opt-add"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onCommit(query.trim())
                }}
              >
                {s.addCategoryOption(query.trim())}
              </li>
            )}
          </ul>,
          document.body,
        )}
    </>
  )
}
