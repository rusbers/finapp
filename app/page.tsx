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

import { useState, useSyncExternalStore } from "react"
import { fromCents } from "@/lib/core/reconciliation"
import { downloadCsv, findBalanceBreaks } from "@/lib/core/verification"
import type { StatementData, ReconciliationResult, ExtractionAttempt } from "@/lib/core/types"
import { strings as s } from "@/lib/strings"

interface ApiResponse {
  data: StatementData
  reconciliation: ReconciliationResult
  attempts: ExtractionAttempt[]
  modelUsed: string
  fallbackUsed: boolean
  fileName: string
}

// Default test settings + where they're saved in the browser.
const DEFAULTS = {
  primaryModel: "gemini-2.5-flash-lite",
  fallbackModel: "gemini-2.5-pro",
  enableFallback: false,
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

export default function Page() {
  const [file, setFile] = useState<File | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)

  // Test controls — read from the localStorage-backed store (SSR-safe, no warnings).
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettingsSnapshot,
    getSettingsServerSnapshot,
  )
  const { primaryModel, fallbackModel, enableFallback } = settings
  const updateSettings = (patch: Partial<Settings>) => saveSettings({ ...settings, ...patch })
  const resetSettings = () => saveSettings(DEFAULTS)

  async function handleCheck() {
    if (!file) return
    setIsLoading(true)
    setError(null)
    setResult(null)
    setDurationMs(null)
    const startedAt = performance.now()
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("primaryModel", primaryModel)
      fd.append("fallbackModel", fallbackModel)
      fd.append("enableFallback", String(enableFallback))
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

  const r = result?.reconciliation
  const transactions = result?.data.transactions ?? []
  const hasBalances = transactions.some((t) => t.balance != null)
  // Row-by-row balance check — only meaningful when reconciliation failed.
  const breaks = result && r && !r.passed ? findBalanceBreaks(result.data) : []
  const breakIndexes = new Set(breaks.map((b) => b.index))

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
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
            setError(null)
            setDurationMs(null)
          }}
        />
        <button className="button" onClick={handleCheck} disabled={!file || isLoading}>
          {isLoading ? s.checkingButton : s.checkButton}
        </button>

        {/* Test controls */}
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
      </section>

      {error && <div className="error">{error}</div>}

      {result && r && (
        <>
          {/* Verdict — the signature element */}
          <div className={`verdict ${r.passed ? "pass" : "fail"}`}>
            <div className="verdict-head">
              <span className="pill">{r.passed ? "✓" : "!"}</span>
              {r.passed ? s.verdictPass : s.verdictFail}
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

            {!r.passed && (
              <div className="discrepancy-note">
                {s.discrepancyNote(fromCents(Math.abs(r.discrepancyCents)))}
              </div>
            )}
          </div>

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

          {/* Row-by-row balance diagnosis (only when failed) */}
          {!r.passed && (
            <div className="breaks">
              {!hasBalances ? (
                <p className="breaks-msg">{s.breaksNoBalance}</p>
              ) : breaks.length === 0 ? (
                <p className="breaks-msg">{s.breaksNone}</p>
              ) : (
                <>
                  <p className="breaks-msg">{s.breaksHeading(breaks.length)}</p>
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
                downloadCsv(result.data, result.fileName.replace(/\.pdf$/i, "") + ".csv")
              }
            >
              {s.downloadCsv}
            </button>
          </div>

          {/* Transaction table — for manual verification against the PDF */}
          <table>
            <thead>
              <tr>
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
    </main>
  )
}
