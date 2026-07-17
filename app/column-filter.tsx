"use client"

/**
 * Excel/Sheets-style per-column header dropdown: sort (asc/desc) + a type-specific
 * filter for one column. Rendered inside a <th>; the dropdown panel is portalled to
 * <body> and positioned `fixed` under the trigger (same technique as
 * category-combobox.tsx) so the table's `overflow: hidden` can't clip it.
 *
 * Display-only: the parent applies the sort/filter to a copy of the rows; nothing here
 * touches the data or reconciliation.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { buildDateTree } from "./table-view"
import { strings as s } from "@/lib/strings"

type Base = {
  label: string
  /** Right-aligned numeric columns anchor the panel to the trigger's right edge. */
  align?: "left" | "right"
  sortDir: "asc" | "desc" | null
  onSort: (dir: "asc" | "desc") => void
  active: boolean
  onClear: () => void
  open: boolean
  onToggle: () => void
  onClose: () => void
}
type Variant =
  | { type: "sort" } // sort asc/desc only, no filter body (e.g. the "#" row-order column)
  | { type: "text"; value: string; onChange: (v: string) => void }
  | { type: "checkbox"; value: string[] | null; options: string[]; onChange: (v: string[] | null) => void }
  | { type: "dateTree"; value: string[] | null; options: string[]; onChange: (v: string[] | null) => void }
  | { type: "numberRange"; value: { min?: number; max?: number }; onChange: (v: { min?: number; max?: number }) => void }

type Props = Base & Variant

const PANEL_WIDTH = 240
const PANEL_MAX_HEIGHT = 320

export default function ColumnFilter(props: Props) {
  const { label, align = "left", sortDir, onSort, active, onClear, open, onToggle, onClose } = props
  // Sort labels read naturally per column type (text = A→Z, dates = oldest→newest).
  const ascLabel = props.type === "text" ? s.sortAtoZ : props.type === "dateTree" ? s.sortOldToNew : s.sortAsc
  const descLabel = props.type === "text" ? s.sortZtoA : props.type === "dateTree" ? s.sortNewToOld : s.sortDesc
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Position the portalled panel under the trigger; clamp inside the viewport.
  // The panel is rendered first (hidden) so we can measure its REAL height — a short
  // panel (e.g. the Description filter) then sits right under the header instead of
  // being pushed far above it by the max-height estimate.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const panelH = panelRef.current?.offsetHeight || PANEL_MAX_HEIGHT
      const below = window.innerHeight - r.bottom
      // Flip above the trigger only when the panel genuinely doesn't fit below.
      const flip = below < panelH + 8 && r.top > below
      let left = align === "right" ? r.right - PANEL_WIDTH : r.left
      left = Math.max(8, Math.min(left, window.innerWidth - PANEL_WIDTH - 8))
      const top = flip ? Math.max(8, r.top - 4 - panelH) : r.bottom + 4
      setPos({ top, left })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, align])

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  return (
    <span className="th-inner">
      <span className="th-label">{label}</span>
      {sortDir && <span className="sort-ind">{sortDir === "asc" ? "▲" : "▼"}</span>}
      <button
        ref={triggerRef}
        type="button"
        className={`col-filter-btn${active ? " active" : ""}`}
        aria-label={s.columnMenuAria(label)}
        aria-expanded={open}
        onClick={onToggle}
      >
        ▾
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="filter-panel"
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width: PANEL_WIDTH,
              // Hidden (but laid out, so measurable) until positioned — avoids a flash
              // at (0,0) and lets the layout effect read the real height first.
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <div className="filter-sort">
              <button
                type="button"
                className={sortDir === "asc" ? "active" : ""}
                onClick={() => onSort("asc")}
              >
                ▲ {ascLabel}
              </button>
              <button
                type="button"
                className={sortDir === "desc" ? "active" : ""}
                onClick={() => onSort("desc")}
              >
                ▼ {descLabel}
              </button>
            </div>
            {props.type !== "sort" && (
              <>
                <div className="filter-sep" />
                <FilterBody {...props} />
              </>
            )}
            {active && (
              <div className="filter-actions">
                <button type="button" className="link-button" onClick={onClear}>
                  {s.clearColumn}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** The filter section, whose shape depends on the column type. */
function FilterBody(props: Props) {
  if (props.type === "sort") return null // sort-only column: no filter body
  if (props.type === "text") {
    return (
      <input
        type="search"
        className="filter-input"
        placeholder={s.filterContains}
        autoFocus
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  }

  if (props.type === "checkbox") {
    const { value, options, onChange } = props
    const selected = value == null ? new Set(options) : new Set(value)
    const toggle = (opt: string) => {
      const next = new Set(selected)
      if (next.has(opt)) next.delete(opt)
      else next.add(opt)
      onChange(next.size === options.length ? null : [...next])
    }
    return (
      <>
        <div className="filter-check-actions">
          <button type="button" className="link-button" onClick={() => onChange(null)}>
            {s.filterSelectAll}
          </button>
          <button type="button" className="link-button" onClick={() => onChange([])}>
            {s.filterDeselectAll}
          </button>
        </div>
        <ul className="filter-check-list">
          {options.map((opt) => (
            <li key={opt}>
              <label>
                <input type="checkbox" checked={selected.has(opt)} onChange={() => toggle(opt)} />
                {opt}
              </label>
            </li>
          ))}
        </ul>
      </>
    )
  }

  if (props.type === "dateTree") {
    return <DateFilterTree value={props.value} options={props.options} onChange={props.onChange} />
  }

  // numberRange
  const { value, onChange } = props
  const parse = (v: string) => (v === "" ? undefined : Number(v))
  return (
    <div className="filter-range">
      <label>
        <span>{s.filterMin}</span>
        <input
          type="number"
          inputMode="decimal"
          value={value.min ?? ""}
          onChange={(e) => onChange({ ...value, min: parse(e.target.value) })}
        />
      </label>
      <label>
        <span>{s.filterMax}</span>
        <input
          type="number"
          inputMode="decimal"
          value={value.max ?? ""}
          onChange={(e) => onChange({ ...value, max: parse(e.target.value) })}
        />
      </label>
    </div>
  )
}

/** A checkbox that can also show the "partially selected" (indeterminate) state, which
 * HTML only exposes via a DOM property (not an attribute) — hence the ref. */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} />
}

/** Excel-style Year → Month → Day checkbox tree for the date column. `value` is the set of
 * selected ISO days (null = all). Toggling a year/month toggles all its days. */
function DateFilterTree({
  value,
  options,
  onChange,
}: {
  value: string[] | null
  options: string[]
  onChange: (v: string[] | null) => void
}) {
  const tree = buildDateTree(options)
  const selected = value == null ? new Set(options) : new Set(value)
  // Expand the year automatically when there's only one (common: a single-year statement).
  const [expandedYears, setExpandedYears] = useState<Set<string>>(
    () => new Set(tree.length === 1 ? [tree[0].year] : []),
  )
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set())

  const commit = (next: Set<string>) =>
    onChange(next.size === options.length ? null : [...next])
  // Add/remove a group of days together (a whole year or month), or a single day.
  const toggleDays = (days: string[]) => {
    const allOn = days.every((d) => selected.has(d))
    const next = new Set(selected)
    for (const d of days) {
      if (allOn) next.delete(d)
      else next.add(d)
    }
    commit(next)
  }
  const toggleSet = (key: string, set: Set<string>, setSet: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSet(next)
  }
  const state = (days: string[]) => {
    const on = days.filter((d) => selected.has(d)).length
    return { checked: on === days.length, indeterminate: on > 0 && on < days.length }
  }

  return (
    <>
      <div className="filter-check-actions">
        <button type="button" className="link-button" onClick={() => onChange(null)}>
          {s.filterSelectAll}
        </button>
        <button type="button" className="link-button" onClick={() => onChange([])}>
          {s.filterDeselectAll}
        </button>
      </div>
      <div className="date-tree">
        {tree.map((y) => {
          const yState = state(y.days)
          const yOpen = expandedYears.has(y.year)
          return (
            <div key={y.year}>
              <div className="date-tree-row">
                <button
                  type="button"
                  className="date-tree-toggle"
                  aria-label={yOpen ? "Collapse" : "Expand"}
                  onClick={() => toggleSet(y.year, expandedYears, setExpandedYears)}
                >
                  {yOpen ? "▾" : "▸"}
                </button>
                <label>
                  <TriCheckbox {...yState} onChange={() => toggleDays(y.days)} />
                  {y.year}
                </label>
              </div>
              {yOpen &&
                y.months.map((m) => {
                  const mKey = `${y.year}-${m.mm}`
                  const mState = state(m.days)
                  const mOpen = expandedMonths.has(mKey)
                  return (
                    <div key={mKey}>
                      <div className="date-tree-row date-tree-month">
                        <button
                          type="button"
                          className="date-tree-toggle"
                          aria-label={mOpen ? "Collapse" : "Expand"}
                          onClick={() => toggleSet(mKey, expandedMonths, setExpandedMonths)}
                        >
                          {mOpen ? "▾" : "▸"}
                        </button>
                        <label>
                          <TriCheckbox {...mState} onChange={() => toggleDays(m.days)} />
                          {s.monthNames[Number(m.mm) - 1]}
                        </label>
                      </div>
                      {mOpen &&
                        m.days.map((d) => (
                          <div key={d} className="date-tree-row date-tree-day">
                            <label>
                              <TriCheckbox
                                checked={selected.has(d)}
                                indeterminate={false}
                                onChange={() => toggleDays([d])}
                              />
                              {Number(d.slice(8, 10))}
                            </label>
                          </div>
                        ))}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </>
  )
}
