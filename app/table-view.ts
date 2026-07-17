/**
 * Pure, framework-agnostic filtering + sorting for the transaction table (BACKLOG 1.3).
 *
 * This is DISPLAY-ONLY: it narrows/reorders a COPY of the rows for the table. It never
 * touches the underlying data or reconciliation — the verdict, equation and CSV always
 * use the full, original-order set. Kept out of `page.tsx` so the logic stays testable
 * and the component stays readable.
 */

import type { Transaction } from "@/lib/core/types"

/** Columns that can be sorted / filtered. `row` is the "#" statement-order index — SORT-only
 * (no filter); Source is excluded. `account` is present only in the multi-account table. */
export type ColumnKey = "row" | "account" | "date" | "description" | "debit" | "credit" | "balance" | "category"

/** One active sort criterion at a time (null = original statement order). */
export type SortState = { key: ColumnKey; dir: "asc" | "desc" } | null

/** A numeric range filter (either bound optional). */
export type NumRange = { min?: number; max?: number }

/**
 * Combined column filters — every present+active entry is ANDed together.
 * - description: substring match ("contains").
 * - category: the subset of categories to SHOW; `null`/absent = show all.
 * - date: the subset of ISO days ("YYYY-MM-DD") to SHOW; `null`/absent = show all.
 * - debit/credit/balance: inclusive numeric range.
 */
export type Filters = {
  description?: string
  category?: string[] | null
  date?: string[] | null
  account?: string[] | null
  debit?: NumRange
  credit?: NumRange
  balance?: NumRange
}

/** Totals of the distinct values present, used to tell "all selected" from a real filter. */
export type Totals = { categories: number; dates: number; accounts: number }

/** A displayed row keeps its ORIGINAL index so ids/highlights stay tied to the real row. */
export type DisplayRow = { t: Transaction; idx: number }

const numOk = (value: number | null | undefined, range?: NumRange): boolean => {
  if (!range || (range.min == null && range.max == null)) return true
  if (value == null) return false // filtering by this amount ⇒ rows without it drop out
  if (range.min != null && value < range.min) return false
  if (range.max != null && value > range.max) return false
  return true
}

/** True when a given column currently narrows the view (drives the "active" indicator). */
export function isColumnActive(col: ColumnKey, filters: Filters, totals: Totals): boolean {
  switch (col) {
    case "row":
      return false // "#" is sort-only — no filter to be active
    case "account":
      return filters.account != null && filters.account.length < totals.accounts
    case "description":
      return !!filters.description?.trim()
    case "category":
      return filters.category != null && filters.category.length < totals.categories
    case "date":
      return filters.date != null && filters.date.length < totals.dates
    case "debit":
      return filters.debit?.min != null || filters.debit?.max != null
    case "credit":
      return filters.credit?.min != null || filters.credit?.max != null
    case "balance":
      return filters.balance?.min != null || filters.balance?.max != null
  }
}

/** True when any column filter is active (drives "X of Y" + "Clear all filters"). */
export function anyFilterActive(filters: Filters, totals: Totals): boolean {
  const cols: ColumnKey[] = ["account", "date", "description", "debit", "credit", "balance", "category"]
  return cols.some((c) => isColumnActive(c, filters, totals))
}

/**
 * Filter (AND across columns) then stable-sort a COPY. `categoryOf` is injected so this
 * stays pure while still honouring inline category edits.
 */
export function applyView(
  transactions: Transaction[],
  filters: Filters,
  sort: SortState,
  categoryOf: (t: Transaction) => string,
): DisplayRow[] {
  const q = filters.description?.trim().toLowerCase() ?? ""
  const catSet = filters.category ? new Set(filters.category) : null
  const dateSet = filters.date ? new Set(filters.date) : null
  const accountSet = filters.account ? new Set(filters.account) : null

  let rows: DisplayRow[] = transactions.map((t, idx) => ({ t, idx }))
  rows = rows.filter(({ t }) => {
    if (q && !(t.description || "").toLowerCase().includes(q)) return false
    if (catSet && !catSet.has(categoryOf(t))) return false
    if (dateSet && !dateSet.has(t.date ?? "")) return false
    if (accountSet && !accountSet.has(t.accountLabel ?? "")) return false
    if (!numOk(t.debit, filters.debit)) return false
    if (!numOk(t.credit, filters.credit)) return false
    if (!numOk(t.balance, filters.balance)) return false
    return true
  })

  if (sort) {
    const { key } = sort
    // Compares DisplayRows so "row" can sort on the original index (idx), not a field.
    const cmp = (a: DisplayRow, b: DisplayRow): number => {
      switch (key) {
        case "row":
          return a.idx - b.idx
        case "account":
          return (a.t.accountLabel ?? "").localeCompare(b.t.accountLabel ?? "")
        case "date":
          return (a.t.date ?? "").localeCompare(b.t.date ?? "")
        case "description":
          return (a.t.description ?? "").localeCompare(b.t.description ?? "")
        case "category":
          return categoryOf(a.t).localeCompare(categoryOf(b.t))
        case "debit":
          return (a.t.debit ?? -Infinity) - (b.t.debit ?? -Infinity)
        case "credit":
          return (a.t.credit ?? -Infinity) - (b.t.credit ?? -Infinity)
        case "balance":
          return (a.t.balance ?? -Infinity) - (b.t.balance ?? -Infinity)
      }
    }
    // Array.sort is stable, so equal keys keep their original statement order.
    rows = [...rows].sort(cmp)
    if (sort.dir === "desc") rows.reverse()
  }

  return rows
}

/** A Year → Month → Day grouping of the distinct dates, for the Excel-style date filter.
 * `days` on a year/month node is every ISO day under it (so a node checkbox can toggle its
 * whole subtree and compute its checked/indeterminate state); a leaf is a full ISO day. */
export type DateTree = {
  year: string
  days: string[]
  months: { mm: string; days: string[] }[]
}[]

/** Group distinct ISO days ("YYYY-MM-DD") into the Year→Month→Day tree, chronologically. */
export function buildDateTree(days: string[]): DateTree {
  const sorted = [...days].sort()
  const byYear = new Map<string, Map<string, string[]>>()
  for (const d of sorted) {
    const year = d.slice(0, 4)
    const mm = d.slice(5, 7)
    if (!year || !mm) continue
    let months = byYear.get(year)
    if (!months) byYear.set(year, (months = new Map()))
    const arr = months.get(mm)
    if (arr) arr.push(d)
    else months.set(mm, [d])
  }
  return [...byYear.entries()].map(([year, months]) => ({
    year,
    days: [...months.values()].flat(),
    months: [...months.entries()].map(([mm, mdays]) => ({ mm, days: mdays })),
  }))
}
