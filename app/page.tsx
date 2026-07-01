"use client"

/**
 * Test page: upload ONE statement, see the result, verify it manually.
 * Signature element: the reconciliation equation shown with the real numbers —
 * exactly the check an accountant does by hand.
 *
 * Test aids added:
 *   - a timer (how long extraction + reconciliation took)
 *   - a running-balance column
 *   - CSV export (to compare against other tools)
 *   - row-by-row balance check that highlights where the balance stops adding up
 */

import { useState, useEffect, useMemo, useSyncExternalStore } from "react"
import { fromCents, checkReconciliation } from "@/lib/core/reconciliation"
import { downloadCsv, findBalanceBreaks, isExplainedByCryptoFees, transactionSource } from "@/lib/core/verification"
import type {
  StatementData,
  ReconciliationResult,
  ExtractionAttempt,
  SignCorrection,
  Transaction,
} from "@/lib/core/types"
import { BANK_LABELS, type BankId } from "@/lib/core/prompts"
import { CATEGORIES, normalizeDescription } from "@/lib/core/categorization"
import CategoryCombobox from "./category-combobox"
import ColumnFilter from "./column-filter"
import { applyView, anyFilterActive, isColumnActive } from "./table-view"
import type { ColumnKey, Filters, SortState } from "./table-view"
import { strings as s } from "@/lib/strings"

interface PerFileResult {
  fileName: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  periodStart: string | null
  periodEnd: string | null
}

interface StatementGap {
  afterClosingBalance: number
  nextOpeningBalance: number | null
  beforeEnd: string | null
  afterStart: string | null
}

interface DuplicateStatement {
  fileName: string
  duplicateOf: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  periodStart: string | null
  periodEnd: string | null
}

interface ConsolidatedAccount {
  label: string
  currency: string
  transactionCount: number
  openingBalance: number
  closingBalance: number
  reconciliation: ReconciliationResult
  transactions: Transaction[]
}
interface ConsolidatedResponse {
  bank: string
  allReconciled: boolean
  accounts: ConsolidatedAccount[]
}

interface ApiResponse {
  data: StatementData
  reconciliation: ReconciliationResult
  attempts: ExtractionAttempt[]
  modelUsed: string
  fallbackUsed: boolean
  corrections: SignCorrection[]
  fileName: string
  // Present only when multiple statements were combined:
  perFile?: PerFileResult[]
  gaps?: StatementGap[]
  fullyChained?: boolean
  duplicates?: DuplicateStatement[]
  // Present only when categorization ran (toggle on):
  categorization?: { ruleCount: number; aiCount: number; uniqueAiDescriptions: number } | null
  // Present only for a Revolut consolidated statement (per-account results):
  consolidated?: ConsolidatedResponse
}

// Default test settings + where they're saved in the browser.
const DEFAULTS = {
  primaryModel: "gemini-2.5-flash-lite",
  fallbackModel: "gemini-2.5-pro",
  enableFallback: false,
  bank: "generic" as BankId,
  devMode: false, // production view by default; toggled on for the full developer detail
  categorize: false, // assign a category to each transaction (rules + AI); off = no AI cost
}
const SETTINGS_KEY = "extractionSettings"
type Settings = typeof DEFAULTS

/* ------------------------------------------------------------------ *
 * A tiny localStorage-backed store for the test settings.
 * Read via useSyncExternalStore — React's built-in way to read external
 * state with correct server-side-rendering behavior (the server snapshot
 * returns DEFAULTS, the client reads saved values), so there's no
 * hydration mismatch and no setState-in-effect warning.
 * ------------------------------------------------------------------ */
const settingsListeners = new Set<() => void>()
let cachedRaw: string | null = null
let cachedSettings: Settings = DEFAULTS

function getSettingsSnapshot(): Settings {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SETTINGS_KEY)
  } catch {
    // storage blocked → defaults
  }
  // Return a stable reference unless the stored value actually changed.
  if (raw !== cachedRaw) {
    cachedRaw = raw
    try {
      cachedSettings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
    } catch {
      cachedSettings = DEFAULTS
    }
  }
  return cachedSettings
}

function getSettingsServerSnapshot(): Settings {
  return DEFAULTS // server has no localStorage
}

function subscribeSettings(callback: () => void): () => void {
  settingsListeners.add(callback)
  window.addEventListener("storage", callback) // sync across tabs
  return () => {
    settingsListeners.delete(callback)
    window.removeEventListener("storage", callback)
  }
}

function saveSettings(next: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // ignore write failures
  }
  settingsListeners.forEach((l) => l()) // notify this tab
}

/* ------------------------------------------------------------------ *
 * Financial-period filtering.
 * The accountant reconciles a closing financial YEAR. A combined upload can span
 * past the year boundary (e.g. end-2024 → start-2026); selecting a period slices
 * the extracted series into its own statement — deriving the period's OPENING
 * (the running balance entering it) and CLOSING (the running balance at its end) —
 * so the verdict is a REAL reconciliation of that period, not just hidden rows.
 * ------------------------------------------------------------------ */
type Period = { kind: "all" } | { kind: "year"; year: string } | { kind: "range"; from: string; to: string }

function slicePeriod(data: StatementData, period: Period): StatementData {
  if (period.kind === "all") return data
  const from = period.kind === "year" ? `${period.year}-01-01` : period.from
  const to = period.kind === "year" ? `${period.year}-12-31` : period.to
  const tx = data.transactions
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to)

  const firstIdx = tx.findIndex((t) => !!t.date && inRange(t.date))
  if (firstIdx === -1) {
    return { bank: data.bank, openingBalance: 0, closingBalance: 0, transactions: [] }
  }
  const sliceTx = tx.filter((t) => !!t.date && inRange(t.date))

  // Opening = printed running balance of the row just before the period's first row
  // (in series order); if the period starts at/before the data, the statement's own
  // opening. Fallback (no balances): opening + Σ(credit−debit) of the rows before it.
  const prev = firstIdx > 0 ? tx[firstIdx - 1] : null
  const openingBalance =
    firstIdx === 0
      ? data.openingBalance
      : prev && prev.balance != null
        ? prev.balance
        : data.openingBalance +
          tx.slice(0, firstIdx).reduce((sum, t) => sum + (t.credit || 0) - (t.debit || 0), 0)

  // Closing = printed running balance of the period's last row (fallback: computed).
  const last = sliceTx[sliceTx.length - 1]
  const closingBalance =
    last.balance != null
      ? last.balance
      : openingBalance + sliceTx.reduce((sum, t) => sum + (t.credit || 0) - (t.debit || 0), 0)

  return { bank: data.bank, openingBalance, closingBalance, transactions: sliceTx }
}

/**
 * POST the upload via XMLHttpRequest so we get real UPLOAD progress events (fetch
 * has none). The request is a single multipart POST, so progress is the aggregate
 * bytes-sent percentage; once the body is fully sent we switch to the (server-side)
 * processing phase. Resolves with the parsed JSON and whether the status was 2xx.
 */
function postExtract(
  fd: FormData,
  cb: { onUploadProgress: (pct: number) => void; onUploaded: () => void },
): Promise<{ ok: boolean; data: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/extract")
    xhr.responseType = "json"
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) cb.onUploadProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.upload.onload = () => cb.onUploaded()
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: xhr.response })
    xhr.onerror = () => reject(new Error("Network error"))
    xhr.ontimeout = () => reject(new Error("Request timed out"))
    xhr.send(fd)
  })
}

/** Ref callback: scroll a horizontally-scrollable cell to its END (so a long file
 * name + page show the tail by default). Defined at module scope so the ref is stable
 * — it runs once per row mount and does NOT reset the scroll on re-renders. We set
 * scrollLeft in requestAnimationFrame so it runs AFTER layout (the width cap is
 * applied), otherwise scrollWidth == clientWidth and the box stays at the start. */
function scrollToEnd(el: HTMLSpanElement | null): void {
  if (!el) return
  requestAnimationFrame(() => {
    el.scrollLeft = el.scrollWidth
  })
}

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export default function Page() {
  const [files, setFiles] = useState<File[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>({ kind: "all" })
  const [showTop, setShowTop] = useState(false)
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing">("idle")
  const [uploadPct, setUploadPct] = useState(0)
  const [step, setStep] = useState(0) // cycling Reading→Extracting→Reconciling indicator
  const [flashRow, setFlashRow] = useState<number | null>(null) // row briefly highlighted after a jump
  const [breakCursor, setBreakCursor] = useState(-1) // index of the balance error currently jumped to (-1 = none yet)
  // Category edits: normalized-description → chosen category (propagates to all rows
  // with the same description). `editingCell` = the one cell currently in edit mode.
  const [catOverrides, setCatOverrides] = useState<Record<string, string>>({})
  const [editingCell, setEditingCell] = useState<string | null>(null)
  // Display-only per-column sort + filters (BACKLOG 1.3). Never touch the underlying
  // data or reconciliation — only which rows are shown and in what order.
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<SortState>(null)
  const [openFilter, setOpenFilter] = useState<ColumnKey | null>(null)
  const clearView = () => {
    setFilters({})
    setSort(null)
    setOpenFilter(null)
  }

  // While processing on the server, cycle the step label (cosmetic — conveys
  // activity; the server phase isn't separately observable from one request).
  useEffect(() => {
    if (phase !== "processing") return
    const id = setInterval(() => setStep((s) => (s + 1) % 3), 1200)
    return () => clearInterval(id)
  }, [phase])

  // Show a floating "back to top" button once the user has scrolled down — long
  // transaction tables make scrolling back up tedious.
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 500)
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Reset the "Next error" navigator + display sort/filters on a new result/period.
  useEffect(() => {
    setBreakCursor(-1)
    clearView()
  }, [result, period])

  // Clear category edits when a new result arrives.
  useEffect(() => {
    setCatOverrides({})
    setEditingCell(null)
  }, [result])

  // Test controls — read from the localStorage-backed store (SSR-safe, no warnings).
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettingsSnapshot,
    getSettingsServerSnapshot,
  )
  const { primaryModel, fallbackModel, enableFallback, bank, devMode, categorize } = settings
  const dev = devMode // show full developer detail when on; clean production view when off

  // PTSB is hidden for now: its parser extracts only the numbers, not the
  // descriptions (see the feature/ptsb-parser branch). To re-enable, drop it
  // from HIDDEN_BANKS. We keep BankId/BANK_LABELS intact — this is UI-only.
  const HIDDEN_BANKS: BankId[] = ["ptsb"]
  const visibleBanks = (Object.keys(BANK_LABELS) as BankId[]).filter((id) => !HIDDEN_BANKS.includes(id))
  // A stale "ptsb" persisted in localStorage falls back to "generic" so we never
  // post a hidden bank to the backend.
  const selectedBank: BankId = visibleBanks.includes(bank) ? bank : "generic"
  const updateSettings = (patch: Partial<Settings>) => saveSettings({ ...settings, ...patch })
  const resetSettings = () => saveSettings(DEFAULTS)

  // Scroll the transaction table to a specific row and briefly highlight it, so a
  // listed balance error links straight to its row (no manual scrolling through a
  // long table). Respects prefers-reduced-motion, like the back-to-top button.
  // `index` is the ORIGINAL row index (row ids are keyed by it). A display filter or sort
  // could hide/reorder the target, so we clear the view first, then scroll on the next
  // frame once the full table has re-rendered — discrepancy jumps stay reliable.
  function jumpToRow(index: number) {
    const scroll = () => {
      const el = document.getElementById(`row-${index}`)
      if (!el) return
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" })
      setFlashRow(index)
      window.setTimeout(() => setFlashRow((cur) => (cur === index ? null : cur)), 1500)
    }
    if (sort || Object.keys(filters).length > 0) {
      clearView()
      requestAnimationFrame(() => requestAnimationFrame(scroll))
    } else {
      scroll()
    }
  }

  async function handleCheck() {
    if (files.length === 0) return
    setIsLoading(true)
    setError(null)
    setResult(null)
    setDurationMs(null)
    setPeriod({ kind: "all" })
    setPhase("uploading")
    setUploadPct(0)
    setStep(0)
    const startedAt = performance.now()
    try {
      const fd = new FormData()
      // Send one file under "file" (single-statement path) or many under "files".
      if (files.length === 1) {
        fd.append("file", files[0])
      } else {
        for (const f of files) fd.append("files", f)
      }
      fd.append("primaryModel", primaryModel)
      fd.append("fallbackModel", fallbackModel)
      fd.append("enableFallback", String(enableFallback))
      fd.append("bank", selectedBank)
      fd.append("categorize", String(categorize))
      const { ok, data } = await postExtract(fd, {
        onUploadProgress: (pct) => setUploadPct(pct),
        onUploaded: () => setPhase("processing"),
      })
      if (!ok) throw new Error((data as { error?: string })?.error ?? s.errorGeneric)
      setResult(data as ApiResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : s.errorUnknown)
    } finally {
      setDurationMs(performance.now() - startedAt)
      setIsLoading(false)
      setPhase("idle")
      setUploadPct(0)
    }
  }

  // Distinct calendar years present (for the financial-period chips).
  const years = result?.data
    ? [...new Set(result.data.transactions.map((t) => t.date?.slice(0, 4)).filter((y): y is string => !!y))].sort()
    : []

  // The result, SLICED to the selected financial period (single/combined path).
  // For "all" this is the whole extraction; for a year/range it's that period
  // reconciled on its own (opening/closing derived from the running balance).
  // Memoized so its identity is stable (keeps the display-view memo below cheap).
  const viewData = useMemo(
    () => (result?.data ? slicePeriod(result.data, period) : null),
    [result, period],
  )
  const r = viewData ? checkReconciliation(viewData) : null
  const transactions = viewData?.transactions ?? []
  const hasBalances = transactions.some((t) => t.balance != null)
  const showCategory = transactions.some((t) => !!t.category) // category column only when categorized

  // --- Inline category editing (BACKLOG 1.2) ---
  // Edits are keyed by the NORMALIZED description, so changing one row propagates to
  // every row with the same merchant (not "contains"). Purely informative — never
  // touches reconciliation.
  const catKey = (t: Transaction) => normalizeDescription(t.description) || (t.description || "").toLowerCase()
  const effectiveCategory = (t: Transaction) => catOverrides[catKey(t)] ?? t.category ?? "Other"
  const setCategory = (t: Transaction, value: string) =>
    setCatOverrides((prev) => ({ ...prev, [catKey(t)]: value }))
  const withEditedCategories = (txs: Transaction[]) =>
    txs.map((t) => ({ ...t, category: effectiveCategory(t) }))
  // Suggestions for the edit combobox: the fixed list plus any custom categories
  // the user already typed this session (so a new one is reusable on other rows).
  const catSuggestions = [
    ...CATEGORIES,
    ...[...new Set(Object.values(catOverrides))].filter(
      (c) => !(CATEGORIES as readonly string[]).includes(c),
    ),
  ]
  /** The editable Category cell, shared by the single/combined and consolidated tables.
   * Click-to-edit (one combobox at a time) keeps large tables fast. A datalist-backed
   * <input> lets the user PICK from the list or TYPE a custom category. */
  const categoryCell = (t: Transaction, cellId: string) => {
    const cat = effectiveCategory(t)
    const edited = catOverrides[catKey(t)] !== undefined
    // Commit the typed/picked value (ignore empty or unchanged), then close.
    const commit = (value: string) => {
      const v = value.trim()
      if (v && v !== cat) setCategory(t, v)
      setEditingCell(null)
    }
    return (
      <td className="category">
        {editingCell === cellId ? (
          <CategoryCombobox
            value={cat}
            suggestions={catSuggestions}
            onCommit={commit}
            onCancel={() => setEditingCell(null)}
          />
        ) : (
          <button
            type="button"
            className="cat-edit"
            title={s.editCategory}
            onClick={() => setEditingCell(cellId)}
          >
            {cat}
          </button>
        )}
        {dev && t.categoryByAi && !edited && editingCell !== cellId && (
          <span className="cat-ai">{s.aiTag}</span>
        )}
      </td>
    )
  }
  // --- Display sort + filters (BACKLOG 1.3) ---
  // `displayRows` is the table's view: filter + stable-sort a COPY of the period rows,
  // keeping each row's ORIGINAL index. Reconciliation/verdict/breaks/CSV keep using the
  // full `viewData` (original order) — never `displayRows`.
  const availableCategories = showCategory
    ? [...new Set(transactions.map((t) => effectiveCategory(t)))].sort((a, b) => a.localeCompare(b))
    : []
  const availableDates = [...new Set(transactions.map((t) => t.date).filter((d): d is string => !!d))].sort()
  const totals = { categories: availableCategories.length, dates: availableDates.length }
  const displayRows = useMemo(
    () => applyView(transactions, filters, sort, (t) => catOverrides[catKey(t)] ?? t.category ?? "Other"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, filters, sort, catOverrides],
  )
  const filterActive = anyFilterActive(filters, totals)
  // Column dropdown wiring: one open at a time; sorting replaces the single sort key;
  // each column reads/writes its own slice of `filters`.
  const setFilterSlice = (key: ColumnKey, value: unknown) =>
    setFilters((prev) => {
      const next = { ...prev }
      if (value == null) delete next[key as keyof Filters]
      else (next as Record<string, unknown>)[key] = value
      return next
    })
  const columnFilterProps = (key: ColumnKey, label: string, align: "left" | "right" = "left") => ({
    label,
    align,
    sortDir: sort?.key === key ? sort.dir : null,
    onSort: (dir: "asc" | "desc") => {
      setSort({ key, dir })
      setOpenFilter(null)
    },
    active: isColumnActive(key, filters, totals),
    onClear: () => setFilterSlice(key, undefined),
    open: openFilter === key,
    onToggle: () => setOpenFilter((cur) => (cur === key ? null : key)),
    onClose: () => setOpenFilter((cur) => (cur === key ? null : cur)),
  })

  // Row-by-row balance check — only meaningful when reconciliation failed.
  const breaks = viewData && r && !r.passed ? findBalanceBreaks(viewData) : []
  const breakIndexes = new Set(breaks.map((b) => b.index))
  // Out of balance, but fully explained by Revolut's hidden crypto-sell fees —
  // the extraction is faithful, so show it softer (not a hard failure).
  const softExplained = !!r && !r.passed && isExplainedByCryptoFees(breaks)

  // Files table enrichment (after a check): map each uploaded file by name to its
  // per-file summary or its duplicate record; a single file derives its summary from
  // the whole result.
  const perFileByName = new Map((result?.perFile ?? []).map((p) => [p.fileName, p]))
  const dupByName = new Map((result?.duplicates ?? []).map((d) => [d.fileName, d]))
  const singleSummary =
    result?.data && !result.perFile && !result.consolidated
      ? (() => {
          const dates = result.data.transactions
            .map((t) => t.date)
            .filter((d): d is string => !!d)
            .sort()
          return {
            transactionCount: result.data.transactions.length,
            periodStart: dates[0] ?? null,
            periodEnd: dates[dates.length - 1] ?? null,
            openingBalance: result.data.openingBalance,
            closingBalance: result.data.closingBalance,
          }
        })()
      : null
  const balRange = (open: number, close: number) =>
    `${fromCents(Math.round(open * 100))} → ${fromCents(Math.round(close * 100))}`
  const filesChecked = !!(result && result.data)
  // Every file involved in a duplicate group (the kept original AND its copies) gets a
  // "Duplicate" badge — so each looks the same and the user can drop whichever.
  const duplicateNames = new Set<string>()
  for (const d of result?.duplicates ?? []) {
    duplicateNames.add(d.fileName)
    duplicateNames.add(d.duplicateOf)
  }
  // Rows for the Files table: each uploaded file with its summary (a kept file's
  // perFile entry, or a copy's own identical figures), sorted CHRONOLOGICALLY by covered
  // period after a check (undated / before-check keep upload order). `i` stays the
  // original index so ✕ removes the right file.
  const fileRows = files
    .map((f, i) => {
      const sum = perFileByName.get(f.name) ?? dupByName.get(f.name) ?? (i === 0 ? singleSummary : null)
      return {
        f,
        i,
        isDuplicate: duplicateNames.has(f.name),
        isIgnored: dupByName.has(f.name), // the copy that was excluded from the series
        sum,
        periodStart: sum?.periodStart ?? null,
      }
    })
    .sort((a, b) => {
      if (a.periodStart && b.periodStart && a.periodStart !== b.periodStart)
        return a.periodStart < b.periodStart ? -1 : 1
      if (a.periodStart && !b.periodStart) return -1
      if (!a.periodStart && b.periodStart) return 1
      return a.i - b.i // undated or equal → keep upload order
    })

  return (
    <main className="page">
      <header className="header">
        <button
          type="button"
          className={`dev-toggle ${dev ? "on" : ""}`}
          aria-pressed={dev}
          onClick={() => updateSettings({ devMode: !dev })}
        >
          {s.devView(dev)}
        </button>
      </header>

      <section className="upload">
        <label>{s.fileLabel}</label>
        <input
          type="file"
          accept="application/pdf"
          multiple
          onChange={(e) => {
            setFiles(e.target.files ? Array.from(e.target.files) : [])
            setResult(null)
            setError(null)
            setDurationMs(null)
          }}
        />
        {files.length > 0 && (
          <div className="files">
            <div className="files-head">
              <span className="files-title">{s.filesSelected(files.length)}</span>
              {result?.fullyChained && result.perFile && result.perFile.length > 1 && (
                <span className="chained-ok">✓ {s.chainedOk}</span>
              )}
            </div>
            <table className="files-table">
              <thead>
                <tr>
                  <th>{s.perFileColumns.file}</th>
                  <th className="num">{s.perFileColumns.count}</th>
                  <th>{s.perFileColumns.period}</th>
                  <th>{s.perFileColumns.range}</th>
                  <th className="files-x" aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {fileRows.map(({ f, i, isDuplicate, isIgnored, sum }) => {
                  const removeBtn = (
                    <button
                      type="button"
                      className="file-remove"
                      aria-label={`${s.removeFile} ${f.name}`}
                      disabled={isLoading}
                      onClick={() => {
                        setFiles(files.filter((_, idx) => idx !== i))
                        setResult(null)
                        setError(null)
                        setDurationMs(null)
                      }}
                    >
                      ✕
                    </button>
                  )
                  return (
                    <tr key={`${f.name}-${i}`}>
                      <td className="files-name">
                        {f.name}
                        {isDuplicate && <span className="file-badge">{s.fileBadgeDuplicate}</span>}
                        {isIgnored && (
                          <span className="file-badge file-badge--ignored">{s.fileBadgeIgnored}</span>
                        )}
                      </td>
                      {sum ? (
                        <>
                          <td className="num">{sum.transactionCount}</td>
                          <td className="date">
                            {sum.periodStart && sum.periodEnd
                              ? `${sum.periodStart} → ${sum.periodEnd}`
                              : "—"}
                          </td>
                          <td className="files-range">
                            {balRange(sum.openingBalance, sum.closingBalance)}
                          </td>
                        </>
                      ) : (
                        <td className="files-pending" colSpan={3}>
                          {filesChecked ? "—" : formatSize(f.size)}
                        </td>
                      )}
                      <td className="files-x">{removeBtn}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* Bank — an everyday choice the user makes before checking, kept visible */}
        <div className="controls">
          <div className="control">
            <label className="control-label">{s.bankLabel}</label>
            <select
              value={selectedBank}
              onChange={(e) => updateSettings({ bank: e.target.value as BankId })}
              disabled={isLoading}
            >
              {visibleBanks.map((id) => (
                <option key={id} value={id}>
                  {BANK_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={categorize}
              onChange={(e) => updateSettings({ categorize: e.target.checked })}
              disabled={isLoading}
            />
            {s.categorizeLabel}
          </label>
        </div>

        <button className="button" onClick={handleCheck} disabled={files.length === 0 || isLoading}>
          {isLoading ? s.checkingButton : s.checkButton}
        </button>

        {/* Processing feedback: real upload % then an indeterminate processing phase */}
        {isLoading && (
          <div className="progress-panel">
            {phase === "uploading" ? (
              <>
                <div className="progress">
                  <div className="progress-fill" style={{ width: `${uploadPct}%` }} />
                </div>
                <span className="progress-label">{s.uploading(uploadPct)}</span>
              </>
            ) : (
              <>
                <div className="progress">
                  <div className="progress-indet" />
                </div>
                <div className="steps">
                  {[s.processingSteps.reading, s.processingSteps.extracting, s.processingSteps.reconciling].map(
                    (label, i) => (
                      <span key={i} className={`step ${i === step ? "active" : ""}`}>
                        {label}
                      </span>
                    ),
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Developer / test controls — only in developer view */}
        {dev && (
          <div className="controls">
            <div className="control">
              <label className="control-label">{s.primaryModelLabel}</label>
              <select
                value={primaryModel}
                onChange={(e) => updateSettings({ primaryModel: e.target.value })}
                disabled={isLoading}
              >
                <option value="gemini-2.5-flash-lite">{s.modelLiteName}</option>
                <option value="gemini-2.5-flash">{s.modelFlashName}</option>
                <option value="gemini-2.5-pro">{s.modelProName}</option>
              </select>
            </div>

            <label className="toggle">
              <input
                type="checkbox"
                checked={enableFallback}
                onChange={(e) => updateSettings({ enableFallback: e.target.checked })}
                disabled={isLoading}
              />
              {s.enableFallbackLabel}
            </label>

            <div className="control" style={{ opacity: enableFallback ? 1 : 0.5 }}>
              <label className="control-label">{s.fallbackModelLabel}</label>
              <select
                value={fallbackModel}
                onChange={(e) => updateSettings({ fallbackModel: e.target.value })}
                disabled={isLoading || !enableFallback}
              >
                <option value="gemini-2.5-flash-lite">{s.modelLiteName}</option>
                <option value="gemini-2.5-flash">{s.modelFlashName}</option>
                <option value="gemini-2.5-pro">{s.modelProName}</option>
              </select>
            </div>

            <button
              className="link-button reset-button"
              onClick={resetSettings}
              disabled={isLoading}
              type="button"
            >
              {s.resetButton}
            </button>
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      {result?.consolidated && (
        <>
          <div className={`verdict ${result.consolidated.allReconciled ? "pass" : "fail"}`}>
            <div className="verdict-head">
              <span className="pill">{result.consolidated.allReconciled ? "✓" : "!"}</span>
              {result.consolidated.allReconciled ? s.consolidatedPass : s.consolidatedFail}
            </div>
          </div>
          <div className="per-file">
            <span className="per-file-title">
              {s.consolidatedHeading(result.consolidated.accounts.length)}
            </span>
            <table>
              <thead>
                <tr>
                  <th>{s.consolidatedColumns.account}</th>
                  <th>{s.consolidatedColumns.count}</th>
                  <th>{s.consolidatedColumns.range}</th>
                  <th>{s.consolidatedColumns.status}</th>
                </tr>
              </thead>
              <tbody>
                {result.consolidated.accounts.map((a, i) => (
                  <tr key={i}>
                    <td>{a.label}</td>
                    <td>{a.transactionCount}</td>
                    <td>
                      {a.openingBalance.toFixed(2)} → {a.closingBalance.toFixed(2)} {a.currency}
                    </td>
                    <td className={a.transactionCount === 0 ? "" : a.reconciliation.passed ? "trace-ok" : "trace-fail"}>
                      {a.transactionCount === 0
                        ? "—"
                        : a.reconciliation.passed
                          ? "✓"
                          : `✗ ${fromCents(Math.abs(a.reconciliation.discrepancyCents))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-account detail: one table per current account, each exportable */}
          {result.consolidated.accounts
            .filter((a) => a.transactionCount > 0)
            .map((a, ai) => (
              <div key={ai} className="account-detail">
                <div className="meta">
                  <span>
                    {s.metaBank}: <b>{a.label}</b>
                  </span>
                  <span>
                    {s.metaTransactions}: <b>{a.transactionCount}</b>
                  </span>
                  <span className={a.reconciliation.passed ? "trace-ok" : "trace-fail"}>
                    {a.reconciliation.passed
                      ? `✓ ${s.attemptReconciled}`
                      : `✗ ${fromCents(Math.abs(a.reconciliation.discrepancyCents))}`}
                  </span>
                  <button
                    className="link-button"
                    onClick={() =>
                      downloadCsv(
                        {
                          bank: a.label,
                          openingBalance: a.openingBalance,
                          closingBalance: a.closingBalance,
                          transactions: withEditedCategories(a.transactions),
                        },
                        `${result.fileName.replace(/\.pdf$/i, "")}-${a.currency}.csv`,
                        result.fileName,
                      )
                    }
                  >
                    {s.downloadCsv}
                  </button>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th className="rownum">#</th>
                      <th className="date">{s.thDate}</th>
                      <th className="desc">{s.thDescription}</th>
                      <th className="num">{s.thDebit}</th>
                      <th className="num">{s.thCredit}</th>
                      <th className="num">{s.thBalance}</th>
                      {a.transactions.some((t) => t.category) && <th className="category">{s.thCategory}</th>}
                      <th className="source">{s.thSource}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.transactions.map((t, i) => (
                      <tr key={i}>
                        <td className="rownum">{i + 1}</td>
                        <td className="date">{t.date}</td>
                        <td>{t.description}</td>
                        <td className="num debit">{t.debit ? t.debit.toFixed(2) : ""}</td>
                        <td className="num credit">{t.credit ? t.credit.toFixed(2) : ""}</td>
                        <td className="num">{t.balance != null ? t.balance.toFixed(2) : ""}</td>
                        {a.transactions.some((x) => x.category) && categoryCell(t, `a${ai}-${i}`)}
                        <td className="source" title={transactionSource(t, result.fileName)}>
                          <span className="src-scroll" ref={scrollToEnd}>
                            {t.sourceFile
                              ? `${t.sourceFile}${t.page != null ? `, page ${t.page}` : ""}`
                              : t.page != null
                                ? `page ${t.page}`
                                : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </>
      )}

      {result && r && (
        <>
          {/* Financial period — slice the result to a year/custom range and
              re-reconcile it (opening/closing derived from the running balance). */}
          {result.data && result.data.transactions.length > 0 && (
            <div className="period-bar">
              <span className="period-label">{s.periodLabel}</span>
              <div className="period-chips">
                <button
                  type="button"
                  className={`chip ${period.kind === "all" ? "active" : ""}`}
                  onClick={() => setPeriod({ kind: "all" })}
                >
                  {s.periodAll}
                </button>
                {years.map((y) => (
                  <button
                    key={y}
                    type="button"
                    className={`chip ${period.kind === "year" && period.year === y ? "active" : ""}`}
                    onClick={() => setPeriod({ kind: "year", year: y })}
                  >
                    {y}
                  </button>
                ))}
                <button
                  type="button"
                  className={`chip ${period.kind === "range" ? "active" : ""}`}
                  onClick={() =>
                    setPeriod({
                      kind: "range",
                      from: years[0] ? `${years[0]}-01-01` : "",
                      to: years.length ? `${years[years.length - 1]}-12-31` : "",
                    })
                  }
                >
                  {s.periodCustom}
                </button>
              </div>
              {period.kind === "range" && (
                <div className="period-range">
                  <input
                    type="date"
                    value={period.from}
                    onChange={(e) => setPeriod({ kind: "range", from: e.target.value, to: period.to })}
                  />
                  <span className="period-arrow">→</span>
                  <input
                    type="date"
                    value={period.to}
                    onChange={(e) => setPeriod({ kind: "range", from: period.from, to: e.target.value })}
                  />
                </div>
              )}
              {period.kind !== "all" && (
                <span className="period-covers">
                  {transactions.length > 0
                    ? s.periodCovers(transactions[0].date, transactions[transactions.length - 1].date)
                    : s.periodEmpty}
                </span>
              )}
            </div>
          )}

          {/* Verdict — the signature element */}
          <div className={`verdict ${r.passed ? "pass" : softExplained ? "soft" : "fail"}`}>
            <div className="verdict-head">
              <span className="pill">{r.passed ? "✓" : softExplained ? "≈" : "!"}</span>
              {r.passed ? s.verdictPass : softExplained ? s.verdictSoft : s.verdictFail}
            </div>

            {dev ? (
              /* Developer: the full reconciliation equation (how the balance is derived) */
              <div className="equation">
                <div className="term">
                  <span className="lbl">{s.eqOpening}</span>
                  <span className="val">{fromCents(r.openingBalanceCents)}</span>
                </div>
                <span className="op">+</span>
                <div className="term">
                  <span className="lbl">{s.eqCredits}</span>
                  <span className="val">{fromCents(r.totalCreditCents)}</span>
                </div>
                <span className="op">−</span>
                <div className="term">
                  <span className="lbl">{s.eqDebits}</span>
                  <span className="val">{fromCents(r.totalDebitCents)}</span>
                </div>
                <span className="op">=</span>
                <div className="term">
                  <span className="lbl">{s.eqComputed}</span>
                  <span className="val">{fromCents(r.computedBalanceCents)}</span>
                </div>
                <span className="op">vs</span>
                <div className="term">
                  <span className="lbl">{s.eqClosing}</span>
                  <span className="val">{fromCents(r.closingBalanceCents)}</span>
                </div>
              </div>
            ) : (
              /* Production: a clean figures summary (the year's totals) */
              <div className="summary">
                <div className="term">
                  <span className="lbl">{s.eqOpening}</span>
                  <span className="val">{fromCents(r.openingBalanceCents)}</span>
                </div>
                <div className="term">
                  <span className="lbl">{s.eqCredits}</span>
                  <span className="val">{fromCents(r.totalCreditCents)}</span>
                </div>
                <div className="term">
                  <span className="lbl">{s.eqDebits}</span>
                  <span className="val">{fromCents(r.totalDebitCents)}</span>
                </div>
                <div className="term">
                  <span className="lbl">{s.eqClosing}</span>
                  <span className="val">{fromCents(r.closingBalanceCents)}</span>
                </div>
              </div>
            )}

            {!r.passed && transactions.length === 0 && (
              <div className="discrepancy-note">{s.noTransactionsNote}</div>
            )}
            {!r.passed && transactions.length > 0 && (
              <div className="discrepancy-note">
                {softExplained
                  ? s.discrepancyNoteCrypto(fromCents(Math.abs(r.discrepancyCents)), breaks.length)
                  : s.discrepancyNote(fromCents(Math.abs(r.discrepancyCents)))}
              </div>
            )}
          </div>

          {/* Duplicates are surfaced in the Files table (a red "Duplicate" badge on the
              row), so there is no separate warning block here. */}

          {/* Gap warning — statements don't link up by balance (one may be missing).
              Show WHICH period is missing when we have dates, else the balance jump. */}
          {result.gaps && result.gaps.length > 0 && (
            <div className="gap-warning">
              <strong>{s.gapWarningTitle}</strong>
              <ul className="gap-list">
                {result.gaps.map((g, i) => {
                  const balBefore = fromCents(Math.round(g.afterClosingBalance * 100))
                  const balAfter =
                    g.nextOpeningBalance != null
                      ? fromCents(Math.round(g.nextOpeningBalance * 100))
                      : "—"
                  return (
                    <li key={i}>
                      {dev
                        ? g.beforeEnd && g.afterStart
                          ? s.gapMissingPeriod(g.beforeEnd, g.afterStart, balBefore, balAfter)
                          : s.gapMissingBalances(balBefore, balAfter)
                        : g.beforeEnd && g.afterStart
                          ? s.gapMissingPeriodShort(g.beforeEnd, g.afterStart)
                          : s.gapMissingGeneric}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* The per-file breakdown now lives in the Files table (production), above. */}

          {/* Extraction trace — which models were tried, which reconciled (dev only) */}
          {dev && (
            <div className="trace">
              <span className="trace-title">{s.extractionHeading}</span>
              {result.attempts.map((a, i) => (
                <div className="trace-row" key={i}>
                  <span className="trace-model">{a.model}</span>
                  <span className={a.reconciliationPassed ? "trace-ok" : "trace-fail"}>
                    {a.reconciliationPassed ? `✓ ${s.attemptReconciled}` : `✗ ${s.attemptFailed}`}
                    {!a.reconciliationPassed &&
                      ` (off by ${fromCents(Math.abs(a.discrepancyCents))})`}
                  </span>
                  <span className="trace-time">{(a.durationMs / 1000).toFixed(1)}s</span>
                </div>
              ))}
              <span className="trace-summary">
                {result.fallbackUsed ? s.fallbackTriggered : s.firstTry}
              </span>
              {result.categorization && (
                <div className="trace-row">
                  <span className="trace-model">{s.categorizationHeading}</span>
                  <span className="trace-time">
                    {result.categorization.aiCount > 0
                      ? s.categorizationTrace(
                          result.categorization.ruleCount,
                          result.categorization.aiCount,
                          result.categorization.uniqueAiDescriptions,
                        )
                      : s.categorizationNoAi(result.categorization.ruleCount)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Auto-corrections made from the running balance (transparency, dev only) */}
          {dev && result.corrections.length > 0 && (
            <div className="corrections">
              <p className="corrections-msg">{s.correctionsHeading(result.corrections.length)}</p>
              <ul className="corrections-list">
                {result.corrections.map((c) => (
                  <li key={c.index}>
                    <b>Row {c.index + 1}</b> — {c.date} {c.description}: {c.amount.toFixed(2)} moved
                    from {c.from} to {c.to}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Row-by-row balance diagnosis (only when failed). The list of flagged
              rows is collapsible and closed by default — the cause is summarized. */}
          {!r.passed &&
            (!hasBalances ? (
              <div className="breaks">
                <p className="breaks-msg">{s.breaksNoBalance}</p>
              </div>
            ) : breaks.length === 0 ? (
              <div className="breaks">
                <p className="breaks-msg">{s.breaksNone}</p>
              </div>
            ) : (
              <details className="breaks">
                <summary className="breaks-summary">
                  {softExplained ? s.breaksHeadingCrypto(breaks.length) : s.breaksHeading(breaks.length)}
                </summary>
                <ul className="breaks-list">
                  {breaks.map((b, bi) => (
                    <li key={b.index}>
                      <button
                        type="button"
                        className="row-jump"
                        onClick={() => {
                          jumpToRow(b.index)
                          setBreakCursor(bi) // keep the "Next error" navigator in sync
                        }}
                      >
                        Row {b.index + 1}
                      </button>{" "}
                      — {b.transaction.date} {b.transaction.description}: expected{" "}
                      {fromCents(b.expectedCents)}, shows {fromCents(b.actualCents)} (off by{" "}
                      {fromCents(Math.abs(b.deltaCents))})
                    </li>
                  ))}
                </ul>
              </details>
            ))}

          {/* Details + actions */}
          <div className="meta">
            <span>
              {s.metaBank}: <b>{result.data.bank || "—"}</b>
            </span>
            <span>
              {s.metaTransactions}:{" "}
              <b>
                {filterActive
                  ? s.txCountFiltered(displayRows.length, transactions.length)
                  : transactions.length}
              </b>
            </span>
            {dev && durationMs != null && (
              <span>
                {s.metaDuration}: <b>{(durationMs / 1000).toFixed(1)}s</b>
              </span>
            )}
            <span>
              {s.metaFile}: <b>{result.fileName}</b>
            </span>
            {(filterActive || sort) && (
              <button className="link-button" onClick={clearView}>
                {s.clearAllFilters}
              </button>
            )}
            <button
              className="link-button"
              onClick={() =>
                downloadCsv(
                  {
                    ...(viewData ?? result.data),
                    transactions: withEditedCategories((viewData ?? result.data).transactions),
                  },
                  result.fileName.replace(/\.pdf$/i, "") +
                    (period.kind === "year"
                      ? `-${period.year}`
                      : period.kind === "range"
                        ? `-${period.from}_${period.to}`
                        : "") +
                    ".csv",
                  result.fileName,
                )
              }
            >
              {s.downloadCsv}
            </button>
          </div>

          {/* Transaction table — for manual verification against the PDF. Each column
              header has an Excel-style sort+filter dropdown (ColumnFilter). */}
          <table>
            <thead>
              <tr>
                <th className="rownum">#</th>
                <th className="date sortable">
                  <ColumnFilter type="dateTree" {...columnFilterProps("date", s.thDate)}
                    options={availableDates}
                    value={filters.date ?? null}
                    onChange={(v) => setFilterSlice("date", v == null || v.length === availableDates.length ? undefined : v)} />
                </th>
                <th className="desc sortable">
                  <ColumnFilter type="text" {...columnFilterProps("description", s.thDescription)}
                    value={filters.description ?? ""} onChange={(v) => setFilterSlice("description", v.trim() ? v : undefined)} />
                </th>
                <th className="num sortable">
                  <ColumnFilter type="numberRange" {...columnFilterProps("debit", s.thDebit, "right")}
                    value={filters.debit ?? {}} onChange={(v) => setFilterSlice("debit", v.min == null && v.max == null ? undefined : v)} />
                </th>
                <th className="num sortable">
                  <ColumnFilter type="numberRange" {...columnFilterProps("credit", s.thCredit, "right")}
                    value={filters.credit ?? {}} onChange={(v) => setFilterSlice("credit", v.min == null && v.max == null ? undefined : v)} />
                </th>
                <th className="num sortable">
                  <ColumnFilter type="numberRange" {...columnFilterProps("balance", s.thBalance, "right")}
                    value={filters.balance ?? {}} onChange={(v) => setFilterSlice("balance", v.min == null && v.max == null ? undefined : v)} />
                </th>
                {showCategory && (
                  <th className="category sortable">
                    <ColumnFilter type="checkbox" {...columnFilterProps("category", s.thCategory)}
                      options={availableCategories}
                      value={filters.category ?? null}
                      onChange={(v) => setFilterSlice("category", v == null || v.length === availableCategories.length ? undefined : v)} />
                  </th>
                )}
                <th className="source">{s.thSource}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ t, idx }) => (
                <tr
                  key={idx}
                  id={`row-${idx}`}
                  className={`${breakIndexes.has(idx) ? "break-row" : ""}${flashRow === idx ? " flash" : ""}`}
                >
                  <td className="rownum">{idx + 1}</td>
                  <td className="date">{t.date}</td>
                  <td>{t.description}</td>
                  <td className="num debit">{t.debit ? t.debit.toFixed(2) : ""}</td>
                  <td className="num credit">{t.credit ? t.credit.toFixed(2) : ""}</td>
                  <td className="num">{t.balance != null ? t.balance.toFixed(2) : ""}</td>
                  {showCategory && categoryCell(t, `s${idx}`)}
                  <td className="source" title={transactionSource(t, result.fileName)}>
                    <span className="src-scroll" ref={scrollToEnd}>
                      {t.sourceFile
                        ? `${t.sourceFile}${t.page != null ? `, page ${t.page}` : ""}`
                        : t.page != null
                          ? `page ${t.page}`
                          : ""}
                    </span>
                  </td>
                </tr>
              ))}
              {displayRows.length === 0 && (
                <tr>
                  <td className="filter-empty" colSpan={showCategory ? 8 : 7}>
                    {s.filterNoMatch}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {r && !r.passed && breaks.length > 0 && (
        (() => {
          const n = breaks.length
          // `breakCursor` is the error we're currently on (-1 before the first jump).
          // The counter shows that position; clicking advances to the NEXT error and
          // jumps there, so the badge always matches the row you land on.
          const here = breakCursor < 0 ? -1 : breakCursor % n
          const label = s.nextDiscrepancy(here < 0 ? 1 : here + 1, n)
          return (
            <button
              type="button"
              className="next-error"
              aria-label={label}
              title={label}
              onClick={() => {
                const next = (here + 1 + n) % n
                jumpToRow(breaks[next].index)
                setBreakCursor(next)
              }}
            >
              {label}
            </button>
          )
        })()
      )}

      {showTop && (
        <button
          type="button"
          className="scroll-top"
          aria-label={s.backToTop}
          title={s.backToTop}
          onClick={() => {
            const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
            window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" })
          }}
        >
          ↑
        </button>
      )}
    </main>
  )
}
