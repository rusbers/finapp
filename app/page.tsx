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

import { useState, useEffect, useSyncExternalStore } from "react"
import { fromCents, checkReconciliation } from "@/lib/core/reconciliation"
import { downloadCsv, findBalanceBreaks, isExplainedByCryptoFees } from "@/lib/core/verification"
import type {
  StatementData,
  ReconciliationResult,
  ExtractionAttempt,
  SignCorrection,
  Transaction,
} from "@/lib/core/types"
import { BANK_LABELS, type BankId } from "@/lib/core/prompts"
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
  // Present only for a Revolut consolidated statement (per-account results):
  consolidated?: ConsolidatedResponse
}

// Default test settings + where they're saved in the browser.
const DEFAULTS = {
  primaryModel: "gemini-2.5-flash-lite",
  fallbackModel: "gemini-2.5-pro",
  enableFallback: false,
  bank: "generic" as BankId,
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

export default function Page() {
  const [files, setFiles] = useState<File[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>({ kind: "all" })
  const [showTop, setShowTop] = useState(false)

  // Show a floating "back to top" button once the user has scrolled down — long
  // transaction tables make scrolling back up tedious.
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 500)
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // Test controls — read from the localStorage-backed store (SSR-safe, no warnings).
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettingsSnapshot,
    getSettingsServerSnapshot,
  )
  const { primaryModel, fallbackModel, enableFallback, bank } = settings
  const updateSettings = (patch: Partial<Settings>) => saveSettings({ ...settings, ...patch })
  const resetSettings = () => saveSettings(DEFAULTS)

  async function handleCheck() {
    if (files.length === 0) return
    setIsLoading(true)
    setError(null)
    setResult(null)
    setDurationMs(null)
    setPeriod({ kind: "all" })
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
      fd.append("bank", bank)
      const res = await fetch("/api/extract", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? s.errorGeneric)
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : s.errorUnknown)
    } finally {
      setDurationMs(performance.now() - startedAt)
      setIsLoading(false)
    }
  }

  // Distinct calendar years present (for the financial-period chips).
  const years = result?.data
    ? [...new Set(result.data.transactions.map((t) => t.date?.slice(0, 4)).filter((y): y is string => !!y))].sort()
    : []

  // The result, SLICED to the selected financial period (single/combined path).
  // For "all" this is the whole extraction; for a year/range it's that period
  // reconciled on its own (opening/closing derived from the running balance).
  const viewData = result?.data ? slicePeriod(result.data, period) : null
  const r = viewData ? checkReconciliation(viewData) : null
  const transactions = viewData?.transactions ?? []
  const hasBalances = transactions.some((t) => t.balance != null)
  // Row-by-row balance check — only meaningful when reconciliation failed.
  const breaks = viewData && r && !r.passed ? findBalanceBreaks(viewData) : []
  const breakIndexes = new Set(breaks.map((b) => b.index))
  // Out of balance, but fully explained by Revolut's hidden crypto-sell fees —
  // the extraction is faithful, so show it softer (not a hard failure).
  const softExplained = !!r && !r.passed && isExplainedByCryptoFees(breaks)

  return (
    <main className="page">
      <header className="header">
        <h1>
          <span className="brand">{s.appName}</span> — {s.pageTitle}
        </h1>
        <p>{s.pageSubtitle}</p>
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
        {files.length > 1 && (
          <div className="file-list">
            {files.length} files selected: {files.map((f) => f.name).join(", ")}
          </div>
        )}
        <button className="button" onClick={handleCheck} disabled={files.length === 0 || isLoading}>
          {isLoading ? s.checkingButton : s.checkButton}
        </button>

        {/* Test controls */}
        <div className="controls">
          <div className="control">
            <label className="control-label">{s.bankLabel}</label>
            <select
              value={bank}
              onChange={(e) => updateSettings({ bank: e.target.value as BankId })}
              disabled={isLoading}
            >
              {(Object.keys(BANK_LABELS) as BankId[]).map((id) => (
                <option key={id} value={id}>
                  {BANK_LABELS[id]}
                </option>
              ))}
            </select>
          </div>

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
                          transactions: a.transactions,
                        },
                        `${result.fileName.replace(/\.pdf$/i, "")}-${a.currency}.csv`,
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
                      <th>{s.thDescription}</th>
                      <th className="num">{s.thDebit}</th>
                      <th className="num">{s.thCredit}</th>
                      <th className="num">{s.thBalance}</th>
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
                      {g.beforeEnd && g.afterStart
                        ? s.gapMissingPeriod(g.beforeEnd, g.afterStart, balBefore, balAfter)
                        : s.gapMissingBalances(balBefore, balAfter)}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* Per-file breakdown when several statements were combined */}
          {result.perFile && result.perFile.length > 1 && (
            <div className="per-file">
              <span className="per-file-title">{s.perFileHeading}</span>
              {result.fullyChained && <span className="chained-ok">✓ {s.chainedOk}</span>}
              <table>
                <thead>
                  <tr>
                    <th>{s.perFileColumns.file}</th>
                    <th>{s.perFileColumns.count}</th>
                    <th>{s.perFileColumns.period}</th>
                    <th>{s.perFileColumns.range}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perFile.map((pf, i) => (
                    <tr key={i}>
                      <td>{pf.fileName}</td>
                      <td>{pf.transactionCount}</td>
                      <td className="date">
                        {pf.periodStart && pf.periodEnd ? `${pf.periodStart} → ${pf.periodEnd}` : "—"}
                      </td>
                      <td>
                        {fromCents(Math.round(pf.openingBalance * 100))} →{" "}
                        {fromCents(Math.round(pf.closingBalance * 100))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Extraction trace — which models were tried, which reconciled */}
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
          </div>

          {/* Auto-corrections made from the running balance (transparency) */}
          {result.corrections.length > 0 && (
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

          {/* Row-by-row balance diagnosis (only when failed) */}
          {!r.passed && (
            <div className="breaks">
              {!hasBalances ? (
                <p className="breaks-msg">{s.breaksNoBalance}</p>
              ) : breaks.length === 0 ? (
                <p className="breaks-msg">{s.breaksNone}</p>
              ) : (
                <>
                  <p className="breaks-msg">
                    {softExplained
                      ? s.breaksHeadingCrypto(breaks.length)
                      : s.breaksHeading(breaks.length)}
                  </p>
                  <ul className="breaks-list">
                    {breaks.map((b) => (
                      <li key={b.index}>
                        <b>Row {b.index + 1}</b> — {b.transaction.date} {b.transaction.description}:
                        expected {fromCents(b.expectedCents)}, shows {fromCents(b.actualCents)} (off
                        by {fromCents(Math.abs(b.deltaCents))})
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* Details + actions */}
          <div className="meta">
            <span>
              {s.metaBank}: <b>{result.data.bank || "—"}</b>
            </span>
            <span>
              {s.metaTransactions}: <b>{transactions.length}</b>
            </span>
            {durationMs != null && (
              <span>
                {s.metaDuration}: <b>{(durationMs / 1000).toFixed(1)}s</b>
              </span>
            )}
            <span>
              {s.metaFile}: <b>{result.fileName}</b>
            </span>
            <button
              className="link-button"
              onClick={() =>
                downloadCsv(
                  viewData ?? result.data,
                  result.fileName.replace(/\.pdf$/i, "") +
                    (period.kind === "year"
                      ? `-${period.year}`
                      : period.kind === "range"
                        ? `-${period.from}_${period.to}`
                        : "") +
                    ".csv",
                )
              }
            >
              {s.downloadCsv}
            </button>
          </div>

          {/* Transaction table — for manual verification against the PDF */}
          <table>
            <thead>
              <tr>
                <th className="rownum">#</th>
                <th className="date">{s.thDate}</th>
                <th>{s.thDescription}</th>
                <th className="num">{s.thDebit}</th>
                <th className="num">{s.thCredit}</th>
                <th className="num">{s.thBalance}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, i) => (
                <tr key={i} className={breakIndexes.has(i) ? "break-row" : ""}>
                  <td className="rownum">{i + 1}</td>
                  <td className="date">{t.date}</td>
                  <td>{t.description}</td>
                  <td className="num debit">{t.debit ? t.debit.toFixed(2) : ""}</td>
                  <td className="num credit">{t.credit ? t.credit.toFixed(2) : ""}</td>
                  <td className="num">{t.balance != null ? t.balance.toFixed(2) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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
