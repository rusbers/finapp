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

import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { fromCents, checkReconciliation } from "@/lib/core/reconciliation"
import { downloadCsv, findBalanceBreaks, isExplainedByCryptoFees, transactionSource } from "@/lib/core/verification"
import type {
  StatementData,
  ReconciliationResult,
  ExtractionAttempt,
  SignCorrection,
  Transaction,
} from "@/lib/core/types"
import { BANK_LABELS, SHORT_BANK_LABELS, type BankId } from "@/lib/core/prompts"
import { isAllowedModel } from "@/lib/core/config"
import { slicePeriod, type Period } from "@/lib/core/period"
import { mergeAccounts } from "@/lib/core/multi-account"
import type { MultiAccount, MultiAccountResult } from "@/lib/core/multi-account"
import { expensesReportToCsv, type ExpenseReport } from "@/lib/core/expenses"
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
  // `data` is ABSENT for a multi-account result (see `multi` below), so it's optional.
  // The other single-statement fields below are only ever read inside the single-mode
  // render branch (gated on a non-null reconciliation), so they stay required — the
  // multi response simply omits them and is never asked for them.
  data?: StatementData
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
  // Present only for a multi-account client (several bank accounts, combined table):
  multi?: MultiAccountResult
  // Present only when an expenses.csv was uploaded (matched against the statement debits):
  expenses?: ExpenseReport
}

/** An additional bank account added in the multi-account upload flow (the primary
 * account stays in `files`/`selectedBank`/`primaryLabel`). */
interface ExtraAccount {
  id: number
  bank: BankId
  label: string
  files: File[]
}

// Default test settings + where they're saved in the browser.
const DEFAULTS = {
  primaryModel: "gemini-2.5-flash-lite",
  fallbackModel: "gemini-2.5-flash",
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

/** A safe href for an expense's link cell, or null if the value isn't a real web URL.
 * Only http(s) (or a bare www., which we upgrade to https) is allowed — this blocks
 * javascript:/data: and non-URL text, so a matched "link"/"url" column with junk in it
 * simply shows no link. */
function expenseHref(link?: string): string | null {
  const t = (link ?? "").trim()
  if (/^https?:\/\//i.test(t)) return t
  if (/^www\./i.test(t)) return `https://${t}`
  return null
}

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Trigger a client-side download of a text file (e.g. the expenses report CSV). */
function downloadTextFile(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** The individual statements (PDFs) that make up one account, for the per-account
 * breakdown (each with its period + balance range). A multi-file account already
 * carries a `perFile`; a single-file account is summarised into one synthetic entry
 * from its transactions + balances. */
function accountStatements(a: MultiAccount): PerFileResult[] {
  if (a.perFile && a.perFile.length > 0) return a.perFile
  const dates = a.transactions.map((t) => t.date).filter((d): d is string => !!d).sort()
  return [
    {
      fileName: a.fileNames[0] ?? "—",
      transactionCount: a.transactionCount,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      openingBalance: a.openingBalance,
      closingBalance: a.closingBalance,
    },
  ]
}

export default function Page() {
  const [files, setFiles] = useState<File[]>([])
  // Multi-account flow: the primary account stays in `files`/`selectedBank`; each
  // extra account is its own bank + optional label + PDFs. `primaryLabel` is the
  // (optional) label for the primary account, shown only once an extra is added.
  const [extraAccounts, setExtraAccounts] = useState<ExtraAccount[]>([])
  const [primaryLabel, setPrimaryLabel] = useState("")
  const nextAccountId = useRef(1)
  // Optional expenses.csv — matched against the statement debits after reconciling.
  // Revealed by an "Add expenses" button (like adding another account).
  const [expensesFile, setExpensesFile] = useState<File | null>(null)
  const [expensesOpen, setExpensesOpen] = useState(false)
  // "New" badge on the Add-expenses button — dropped once the user has opened it once.
  const [expensesSeen, setExpensesSeen] = useState(false)
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
  // Manual verification (BACKLOG 2.1, simplified): a per-row "verified" tick the user
  // sets while checking rows against the PDF. Keyed by the ORIGINAL row index (like the
  // balance-break set), so it survives filtering/sorting. Purely visual — session-only,
  // never touches the data or reconciliation. The tick column is hidden until the user
  // turns on "Check mode" (off by default).
  const [checkMode, setCheckMode] = useState(false)
  const [verified, setVerified] = useState<Set<number>>(new Set())
  const toggleVerified = (idx: number) =>
    setVerified((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })

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

  // Reset the "Next error" navigator + display sort/filters + verification ticks on a
  // new result/period (verified is keyed by row index, which shifts when the period does).
  useEffect(() => {
    setBreakCursor(-1)
    clearView()
    setVerified(new Set())
  }, [result, period])

  // Clear category edits + exit check mode when a new result arrives.
  useEffect(() => {
    setCatOverrides({})
    setEditingCell(null)
    setCheckMode(false)
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
  // Pro was removed from the model list. A stale "gemini-2.5-pro" persisted in
  // localStorage falls back to a valid model so the selector + the request never
  // carry an unsupported model.
  const selectedPrimaryModel = isAllowedModel(primaryModel) ? primaryModel : DEFAULTS.primaryModel
  const selectedFallbackModel = isAllowedModel(fallbackModel) ? fallbackModel : DEFAULTS.fallbackModel
  const updateSettings = (patch: Partial<Settings>) => saveSettings({ ...settings, ...patch })
  const resetSettings = () => saveSettings(DEFAULTS)

  // --- Multi-account upload (add another bank account) ---
  // Once at least one extra account exists we're in multi-account mode: each account
  // (primary + extras) is reconciled on its own and shown in one combined table.
  const isMultiAccount = extraAccounts.length > 0
  const resetResult = () => {
    setResult(null)
    setError(null)
    setDurationMs(null)
  }
  const addAccount = () => {
    setExtraAccounts((prev) => [
      ...prev,
      { id: nextAccountId.current++, bank: "generic", label: "", files: [] },
    ])
    resetResult()
  }
  const updateAccount = (id: number, patch: Partial<Omit<ExtraAccount, "id">>) => {
    setExtraAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
    resetResult()
  }
  const removeAccount = (id: number) => {
    setExtraAccounts((prev) => prev.filter((a) => a.id !== id))
    resetResult()
  }

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

  // Ready to check when the primary account has files and (in multi mode) every extra
  // account has files too.
  const canCheck =
    files.length > 0 && (!isMultiAccount || extraAccounts.every((a) => a.files.length > 0))
  // Total statements attached (primary + every extra account) — drives the button's
  // singular/plural label.
  const totalStatements = files.length + extraAccounts.reduce((n, a) => n + a.files.length, 0)

  async function handleCheck() {
    if (!canCheck) return
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
      if (isMultiAccount) {
        // Multi-account: the primary account is #0, then the extras. Each account's
        // files go under the repeated key "account-<i>"; the bank/label list is one
        // JSON field. Each account reconciles independently on the server.
        const allAccounts = [
          { bank: selectedBank, label: primaryLabel, files },
          ...extraAccounts.map((a) => ({ bank: a.bank, label: a.label, files: a.files })),
        ]
        fd.append("accounts", JSON.stringify(allAccounts.map((a) => ({ bank: a.bank, label: a.label }))))
        allAccounts.forEach((a, i) => a.files.forEach((f) => fd.append(`account-${i}`, f)))
      } else if (files.length === 1) {
        // Single statement.
        fd.append("file", files[0])
        fd.append("bank", selectedBank)
      } else {
        // Several PDFs of the same account.
        for (const f of files) fd.append("files", f)
        fd.append("bank", selectedBank)
      }
      fd.append("primaryModel", selectedPrimaryModel)
      fd.append("fallbackModel", selectedFallbackModel)
      fd.append("enableFallback", String(enableFallback))
      fd.append("categorize", String(categorize))
      if (expensesFile) fd.append("expenses", expensesFile)
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

  // Distinct calendar years present (for the financial-period chips) — from the single
  // statement OR every multi-account's rows.
  const yearSrc = result?.data?.transactions ?? (result?.multi?.accounts.flatMap((a) => a.transactions) ?? [])
  const years = [...new Set(yearSrc.map((t) => t.date?.slice(0, 4)).filter((y): y is string => !!y))].sort()
  // Filename suffix for the selected period (shared by the single/combined/per-account CSVs).
  const periodSuffix =
    period.kind === "year" ? `-${period.year}` : period.kind === "range" ? `-${period.from}_${period.to}` : ""
  // Show the Financial period bar whenever the result actually has transactions (single or multi).
  const hasResultTx =
    (result?.data?.transactions.length ?? 0) > 0 ||
    (result?.multi?.accounts.some((a) => a.transactions.length > 0) ?? false)

  // The result, SLICED to the selected financial period (single/combined path).
  // For "all" this is the whole extraction; for a year/range it's that period
  // reconciled on its own (opening/closing derived from the running balance).
  // Memoized so its identity is stable (keeps the display-view memo below cheap).
  const viewData = useMemo(
    () => (result?.data ? slicePeriod(result.data, period) : null),
    [result, period],
  )
  const r = viewData ? checkReconciliation(viewData) : null

  // Multi-account: the Financial period slices EACH account to the selected period and
  // re-reconciles it (opening/closing from that account's running balance), exactly like a
  // single statement — so the per-account verdicts, the combined table and the CSVs all
  // reflect the period. For "all" it's the untouched server result.
  const isMulti = !!result?.multi
  const displayMulti = useMemo(() => {
    if (!result?.multi) return null
    if (period.kind === "all") return result.multi
    const accounts = result.multi.accounts.map((a) => {
      const sliced = slicePeriod(
        { bank: a.bank, openingBalance: a.openingBalance, closingBalance: a.closingBalance, transactions: a.transactions },
        period,
      )
      return {
        ...a,
        transactions: sliced.transactions,
        openingBalance: sliced.openingBalance,
        closingBalance: sliced.closingBalance,
        transactionCount: sliced.transactions.length,
        reconciliation: checkReconciliation(sliced),
      }
    })
    return {
      ...result.multi,
      accounts,
      allReconciled: accounts.every((a) => a.transactionCount === 0 || a.reconciliation.passed),
    }
  }, [result, period])
  // Interleave every (sliced) account's rows into ONE chronological list for the combined table.
  const merged = useMemo(
    () =>
      displayMulti
        ? mergeAccounts(displayMulti.accounts.map((a) => ({ label: a.label, transactions: a.transactions })))
        : null,
    [displayMulti],
  )
  const tableData: StatementData | null = merged
    ? { bank: "combined", openingBalance: 0, closingBalance: 0, transactions: merged.transactions }
    : viewData

  const transactions = tableData?.transactions ?? []
  const hasBalances = transactions.some((t) => t.balance != null)
  const showCategory = transactions.some((t) => !!t.category) // category column only when categorized

  // --- Inline category editing (BACKLOG 1.2) ---
  // Edits are keyed by the NORMALIZED description, so changing one row propagates to
  // every row with the same merchant (not "contains"). Purely informative — never
  // touches reconciliation.
  const catKey = (t: Transaction) => normalizeDescription(t.description) || (t.description || "").toLowerCase()
  // For DISPLAY the cell falls back to "Other" (a clickable default). For EXPORT we do
  // NOT invent "Other": a row keeps its real/edited category, otherwise the Category
  // cell stays EMPTY (so an export without categorization has a Category column but no
  // fabricated values). A genuine "Other" assigned by the categorization step is a real
  // value on `t.category` and is preserved either way.
  const effectiveCategory = (t: Transaction) => catOverrides[catKey(t)] ?? t.category ?? "Other"
  const exportCategory = (t: Transaction) => catOverrides[catKey(t)] ?? t.category
  const setCategory = (t: Transaction, value: string) =>
    setCatOverrides((prev) => ({ ...prev, [catKey(t)]: value }))
  const withEditedCategories = (txs: Transaction[]) =>
    txs.map((t) => ({ ...t, category: exportCategory(t) }))
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
  // Bank/source column — shown whenever any row carries an accountLabel (multi-account
  // labels, OR the bank stamped by the route for a single-bank statement).
  const showAccountCol = transactions.some((t) => !!t.accountLabel)
  // Filter values: account order in multi-account; otherwise the distinct labels present.
  const availableAccounts =
    isMulti && displayMulti
      ? displayMulti.accounts.filter((a) => a.transactionCount > 0).map((a) => a.label)
      : [...new Set(transactions.map((t) => t.accountLabel).filter((l): l is string => !!l))]
  const totals = { categories: availableCategories.length, dates: availableDates.length, accounts: availableAccounts.length }
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
          const d = result.data!
          const dates = d.transactions
            .map((t) => t.date)
            .filter((dt): dt is string => !!dt)
            .sort()
          return {
            transactionCount: d.transactions.length,
            periodStart: dates[0] ?? null,
            periodEnd: dates[dates.length - 1] ?? null,
            openingBalance: d.openingBalance,
            closingBalance: d.closingBalance,
          }
        })()
      : null
  const balRange = (open: number, close: number) =>
    `${fromCents(Math.round(open * 100))} → ${fromCents(Math.round(close * 100))}`
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

  // Show the "Link" column only when the uploaded expenses.csv actually carries usable
  // (http/www) links — a plain expenses export leaves the table at its 6 columns.
  const hasExpenseLinks = result?.expenses?.matches.some((m) => expenseHref(m.expense.link)) ?? false

  return (
    <main className="page">
      <header className="header">
        <span className="beta-badge">{s.betaBadge}</span>
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
        {/* Step 1 — choose the bank and (optionally) label this account. */}
        <div className="controls controls--top">
          <div className="control control--grow">
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
          <div className="control control--grow">
            <label className="control-label">{s.accountLabelField}</label>
            <input
              className="account-label-input"
              type="text"
              value={primaryLabel}
              placeholder={SHORT_BANK_LABELS[selectedBank]}
              maxLength={40}
              disabled={isLoading}
              onChange={(e) => {
                setPrimaryLabel(e.target.value)
                resetResult()
              }}
            />
          </div>
        </div>

        {/* Step 2 — upload its statements. */}
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
            </div>
            {/* Compact list (same style as the extra-account file lists), on the upload
                card's background: just the attached files + size. The per-file report
                (period, transactions, balance range) appears in the RESULT after Reconcile. */}
            <ul className="account-files">
              {fileRows.map(({ f, i, isDuplicate, isIgnored }) => (
                <li key={`${f.name}-${i}`}>
                  <span className="account-file-name">{f.name}</span>
                  {isDuplicate && <span className="file-badge">{s.fileBadgeDuplicate}</span>}
                  {isIgnored && (
                    <span className="file-badge file-badge--ignored">{s.fileBadgeIgnored}</span>
                  )}
                  <span className="account-file-size">{formatSize(f.size)}</span>
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
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Extra accounts (a client with several bank accounts). Each has its own bank,
            optional label and PDF(s); all are reconciled independently. */}
        {extraAccounts.map((acc, i) => (
          <div className="account-block" key={acc.id}>
            <div className="account-block-head">
              <span className="account-block-title">{s.accountBlockTitle(i + 2)}</span>
              <button
                type="button"
                className="file-remove"
                aria-label={s.removeAccount}
                disabled={isLoading}
                onClick={() => removeAccount(acc.id)}
              >
                ✕
              </button>
            </div>
            <div className="controls">
              <div className="control control--grow">
                <label className="control-label">{s.bankLabel}</label>
                <select
                  value={acc.bank}
                  disabled={isLoading}
                  onChange={(e) => updateAccount(acc.id, { bank: e.target.value as BankId })}
                >
                  {visibleBanks.map((id) => (
                    <option key={id} value={id}>
                      {BANK_LABELS[id]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control control--grow">
                <label className="control-label">{s.accountLabelField}</label>
                <input
                  className="account-label-input"
                  type="text"
                  value={acc.label}
                  placeholder={SHORT_BANK_LABELS[acc.bank]}
                  maxLength={40}
                  disabled={isLoading}
                  onChange={(e) => updateAccount(acc.id, { label: e.target.value })}
                />
              </div>
            </div>
            <input
              type="file"
              accept="application/pdf"
              multiple
              disabled={isLoading}
              onChange={(e) =>
                updateAccount(acc.id, { files: e.target.files ? Array.from(e.target.files) : [] })
              }
            />
            {acc.files.length > 0 && (
              <ul className="account-files">
                {acc.files.map((f, fi) => (
                  <li key={`${f.name}-${fi}`}>
                    <span className="account-file-name">{f.name}</span>
                    <span className="account-file-size">{formatSize(f.size)}</span>
                    <button
                      type="button"
                      className="file-remove"
                      aria-label={`${s.removeFile} ${f.name}`}
                      disabled={isLoading}
                      onClick={() =>
                        updateAccount(acc.id, { files: acc.files.filter((_, idx) => idx !== fi) })
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

        {/* Appears once the first bank's statements are attached. */}
        {files.length > 0 && (
          <button type="button" className="link-button add-account" onClick={addAccount} disabled={isLoading}>
            {s.addAccountButton}
          </button>
        )}

        {/* Add expenses — reveals the expenses.csv uploader (matched against the debits).
            Carries a green "New" badge (dropped after the first open) + an info tooltip. */}
        {files.length > 0 && !expensesOpen && (
          <div className="add-expenses-row">
            <button
              type="button"
              className="link-button add-account"
              onClick={() => {
                setExpensesOpen(true)
                setExpensesSeen(true)
              }}
              disabled={isLoading}
            >
              {s.addExpensesButton}
              {!expensesSeen && <span className="badge-new">{s.newBadge}</span>}
            </button>
            <span className="info-tip info-tip--start" tabIndex={0} aria-label={s.expensesInfo}>
              i<span className="info-tip-bubble">{s.expensesInfo}</span>
            </span>
          </div>
        )}
        {expensesOpen && (
          <div className="expenses-input">
            <div className="account-block-head">
              <label className="control-label">{s.expensesLabel}</label>
              <button
                type="button"
                className="file-remove"
                aria-label={s.removeExpenses}
                disabled={isLoading}
                onClick={() => {
                  setExpensesOpen(false)
                  setExpensesFile(null)
                  resetResult()
                }}
              >
                ✕
              </button>
            </div>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={isLoading}
              onChange={(e) => {
                setExpensesFile(e.target.files?.[0] ?? null)
                resetResult()
              }}
            />
          </div>
        )}

        {/* Categorization is a per-run cost choice, made right before reconciling. */}
        <label className="toggle categorize-toggle">
          <input
            type="checkbox"
            checked={categorize}
            onChange={(e) => updateSettings({ categorize: e.target.checked })}
            disabled={isLoading}
          />
          {s.categorizeLabel}
        </label>

        <button className="button" onClick={handleCheck} disabled={!canCheck || isLoading}>
          {isLoading ? s.checkingButton : s.checkButton(totalStatements)}
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
                value={selectedPrimaryModel}
                onChange={(e) => updateSettings({ primaryModel: e.target.value })}
                disabled={isLoading}
              >
                <option value="gemini-2.5-flash-lite">{s.modelLiteName}</option>
                <option value="gemini-2.5-flash">{s.modelFlashName}</option>
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
                value={selectedFallbackModel}
                onChange={(e) => updateSettings({ fallbackModel: e.target.value })}
                disabled={isLoading || !enableFallback}
              >
                <option value="gemini-2.5-flash-lite">{s.modelLiteName}</option>
                <option value="gemini-2.5-flash">{s.modelFlashName}</option>
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

      {/* Expense reconciliation — the uploaded expenses.csv matched against the
          statement debits (found / not found per expense). Shown in addition to the
          normal reconciliation result. */}
      {result?.expenses && (
        <>
          <div
            className={`verdict ${result.expenses.foundCount === result.expenses.total ? "pass" : "soft"}`}
          >
            <div className="verdict-head">
              <span className="pill">
                {result.expenses.foundCount === result.expenses.total ? "✓" : "≈"}
              </span>
              {s.expensesSummary(result.expenses.foundCount, result.expenses.total)}
            </div>
          </div>
          <div className="per-file">
            <div className="files-head">
              <span className="per-file-title">{s.expensesHeading}</span>
              <button
                className="link-button"
                onClick={() =>
                  downloadTextFile(expensesReportToCsv(result.expenses!), "expenses-reconciled.csv")
                }
              >
                {s.downloadCsv}
              </button>
            </div>
            <table className="files-table expenses-table">
              <thead>
                <tr>
                  <th>{s.expensesColumns.supplier}</th>
                  <th>{s.expensesColumns.category}</th>
                  <th className="date">{s.expensesColumns.date}</th>
                  <th className="num">{s.expensesColumns.amount}</th>
                  <th>{s.expensesColumns.found}</th>
                  <th>{s.expensesColumns.matched}</th>
                  {hasExpenseLinks && <th>{s.expensesColumns.link}</th>}
                </tr>
              </thead>
              <tbody>
                {result.expenses.matches.map((m, i) => {
                  // "Matched" shows the account (bank / label) first, then the date. The
                  // Source (which file it came from) is intentionally NOT shown on screen —
                  // it lives only in the CSV export (expensesReportToCsv).
                  const matched = m.found
                    ? `${m.matchedAccount ? `${m.matchedAccount} · ` : ""}${m.matchedDate ?? ""}`
                    : ""
                  const href = expenseHref(m.expense.link)
                  return (
                    <tr key={i} className={m.found ? "" : "expense-missing"}>
                      <td title={m.expense.supplier}>{m.expense.supplier}</td>
                      <td title={m.expense.category}>{m.expense.category}</td>
                      <td className="date">{m.expense.date}</td>
                      <td className="num">{m.expense.amount.toFixed(2)}</td>
                      <td className={m.found ? "trace-ok" : "trace-fail"}>
                        {m.found ? `✓ ${s.expenseFound}` : `✗ ${s.expenseNotFound}`}
                      </td>
                      <td className="date" title={matched}>
                        {matched}
                      </td>
                      {hasExpenseLinks && (
                        <td>
                          {href && (
                            <a
                              className="expense-link"
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {s.expenseLinkText}
                            </a>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

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

      {/* Multiple bank accounts (one client) — each reconciled independently, shown
          in one combined table below. */}
      {/* Financial period — slice the whole result (a single statement OR every account) to a
          year/custom range and RE-RECONCILE it (opening/closing derived from the running
          balance): the verdict(s), the combined table and the CSVs all reflect the period.
          Shown for both single and multi-account. */}
      {hasResultTx && (
        <div className="period-bar">
          <span className="period-label">{s.periodLabel}</span>
          <span className="info-tip" tabIndex={0} aria-label={s.periodHint}>
            i<span className="info-tip-bubble">{s.periodHint}</span>
          </span>
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

      {displayMulti && (
        <>
          <div className={`verdict ${displayMulti.allReconciled ? "pass" : "fail"}`}>
            <div className="verdict-head">
              <span className="pill">{displayMulti.allReconciled ? "✓" : "!"}</span>
              {displayMulti.allReconciled ? s.multiPass : s.multiFail}
            </div>
          </div>
          <div className="multi-head">
            <span className="per-file-title">{s.multiHeading(displayMulti.accounts.length)}</span>
          </div>

          {/* One block per account: header (bank · tx · reconciled · CSV) + a per-statement
              breakdown showing each PDF's period and balance range (only for the full period —
              a year/range slice re-reconciles each account but the per-file rows are unsliced). */}
          {displayMulti.accounts.map((a, ai) => (
            <div key={ai} className="account-detail">
              <div className="meta">
                <span className="account-name">
                  <b>{a.label}</b>
                </span>
                <span>
                  {BANK_LABELS[a.bank]}
                  {a.currency ? ` · ${a.currency}` : ""}
                </span>
                <span>
                  {s.metaTransactions}: <b>{a.transactionCount}</b>
                </span>
                <span className={a.transactionCount === 0 ? "" : a.reconciliation.passed ? "trace-ok" : "trace-fail"}>
                  {a.transactionCount === 0
                    ? "—"
                    : a.reconciliation.passed
                      ? `✓ ${s.attemptReconciled}`
                      : `✗ ${fromCents(Math.abs(a.reconciliation.discrepancyCents))}`}
                </span>
                {a.transactionCount > 0 && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      downloadCsv(
                        {
                          bank: a.label,
                          openingBalance: a.openingBalance,
                          closingBalance: a.closingBalance,
                          transactions: withEditedCategories(a.transactions),
                        },
                        `${a.label.replace(/[^\w.-]+/g, "_")}${periodSuffix}.csv`,
                        a.fileNames[0],
                      )
                    }
                  >
                    {s.downloadCsv}
                  </button>
                )}
              </div>
              {period.kind === "all" && a.transactionCount > 0 && (
                <table className="files-table">
                  <thead>
                    <tr>
                      <th>{s.perFileColumns.file}</th>
                      <th className="num">{s.perFileColumns.count}</th>
                      <th>{s.perFileColumns.period}</th>
                      <th>{s.perFileColumns.range}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountStatements(a).map((p, pi) => (
                      <tr key={pi}>
                        <td className="files-name">{p.fileName}</td>
                        <td className="num">{p.transactionCount}</td>
                        <td className="date">
                          {p.periodStart && p.periodEnd ? `${p.periodStart} → ${p.periodEnd}` : "—"}
                        </td>
                        <td className="files-range">
                          {balRange(p.openingBalance, p.closingBalance)}
                          {a.currency ? ` ${a.currency}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          {/* Per-account gap warnings — a missing statement in that account's series. */}
          {displayMulti.accounts.some((a) => a.gaps && a.gaps.length > 0) && (
            <div className="gap-warning">
              <strong>{s.gapWarningTitle}</strong>
              <ul className="gap-list">
                {displayMulti.accounts.flatMap((a) =>
                  (a.gaps ?? []).map((g, gi) => (
                    <li key={`${a.label}-${gi}`}>
                      <b>{a.label}</b>:{" "}
                      {g.beforeEnd && g.afterStart
                        ? s.gapMissingPeriodShort(g.beforeEnd, g.afterStart)
                        : s.gapMissingGeneric}
                    </li>
                  )),
                )}
              </ul>
            </div>
          )}
        </>
      )}

      {result && (r || isMulti) && (
        <>
          {r && (
            <>
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

          {/* Per-statement report — one row per uploaded PDF (period, transactions,
              balance range). Shown for a multi-PDF account; a single file needs none. */}
          {result.perFile && result.perFile.length > 1 && (
            <div className="per-file">
              <span className="per-file-title">{s.perFileHeading(result.perFile.length)}</span>
              {result.fullyChained && <span className="chained-ok">✓ {s.chainedOk}</span>}
              <table className="files-table">
                <thead>
                  <tr>
                    <th>{s.perFileColumns.file}</th>
                    <th className="num">{s.perFileColumns.count}</th>
                    <th>{s.perFileColumns.period}</th>
                    <th>{s.perFileColumns.range}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perFile.map((p, i) => (
                    <tr key={i}>
                      <td className="files-name">{p.fileName}</td>
                      <td className="num">{p.transactionCount}</td>
                      <td className="date">
                        {p.periodStart && p.periodEnd ? `${p.periodStart} → ${p.periodEnd}` : "—"}
                      </td>
                      <td className="files-range">{balRange(p.openingBalance, p.closingBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
            </>
          )}

          {/* Details + actions */}
          <div className="meta">
            <span>
              {isMulti && displayMulti ? (
                <>
                  {s.metaAccountsLabel}: <b>{displayMulti.accounts.length}</b>
                </>
              ) : (
                <>
                  {s.metaBank}: <b>{result.data?.bank || "—"}</b>
                </>
              )}
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
            {transactions.length > 0 && (
              <button
                type="button"
                className="link-button"
                aria-pressed={checkMode}
                onClick={() => setCheckMode((m) => !m)}
              >
                {s.checkMode}
              </button>
            )}
            {checkMode && transactions.length > 0 && (
              <span>
                <b>{s.verifiedCount(verified.size, transactions.length)}</b>
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
                  isMulti && merged
                    ? {
                        bank: "combined",
                        openingBalance: 0,
                        closingBalance: 0,
                        transactions: withEditedCategories(merged.transactions),
                      }
                    : {
                        ...viewData!,
                        transactions: withEditedCategories(viewData!.transactions),
                      },
                  isMulti
                    ? `combined-accounts${periodSuffix}.csv`
                    : result.fileName.replace(/\.pdf$/i, "") + periodSuffix + ".csv",
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
                {checkMode && <th className="check-col" aria-label={s.verifiedColumn}></th>}
                {showAccountCol && (
                  <th className="account sortable">
                    <ColumnFilter type="checkbox" {...columnFilterProps("account", s.thAccount)}
                      options={availableAccounts}
                      value={filters.account ?? null}
                      onChange={(v) => setFilterSlice("account", v == null || v.length === availableAccounts.length ? undefined : v)} />
                  </th>
                )}
                <th className="rownum sortable">
                  <ColumnFilter type="sort" {...columnFilterProps("row", "#")} />
                </th>
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
                  className={`${checkMode && verified.has(idx) ? "verified-row " : ""}${breakIndexes.has(idx) ? "break-row" : ""}${flashRow === idx ? " flash" : ""}`}
                >
                  {checkMode && (
                    <td className="check-col">
                      <input
                        type="checkbox"
                        checked={verified.has(idx)}
                        onChange={() => toggleVerified(idx)}
                        aria-label={s.verifiedColumn}
                      />
                    </td>
                  )}
                  {showAccountCol && <td className="account">{t.accountLabel}</td>}
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
                  <td className="filter-empty" colSpan={(showCategory ? 8 : 7) + (checkMode ? 1 : 0) + (isMulti ? 1 : 0)}>
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
