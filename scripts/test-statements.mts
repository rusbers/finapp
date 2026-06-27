/**
 * Reconciliation regression harness.
 *
 * Runs every real statement under `statements/<bank>/` through the SAME code path
 * the app uses (deterministic parser + reconciliation), records the result per
 * statement, and compares it against the last accepted snapshot (the "baseline")
 * to flag regressions — e.g. a statement that reconciled before but no longer does.
 *
 * Scope: deterministic parsers only (revolut, revolut-consolidated, aib, boi).
 * AI-based banks (PTSB, Other) are intentionally excluded — their extraction is
 * non-deterministic, so a baseline diff would be noise (and would cost API credits).
 *
 * Data lives OUTSIDE git (see .gitignore): input PDFs in `statements/`, results in
 * `.reconcile/` — baseline.json (the accepted records), `snapshots/<key>.csv` (the
 * accepted rows, human-readable, for a row-level diff on regression), and
 * last-run.json (the latest run, overwritten). Nothing here is committed.
 *
 * Usage (via npm):
 *   npm run test:statements                  # all banks, diff vs baseline
 *   npm run test:statements -- aib           # only one bank (the relevant folder)
 *   npm run test:statements -- --update-baseline   # accept current result as baseline
 * The first run (no baseline yet) creates the baseline. Later runs only compare,
 * unless --update-baseline is passed. Exit code is non-zero on a reconciliation
 * change, a missing statement, or a parser error (so it's visible to scripts/CI).
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join, relative, sep, dirname } from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { extractAndReconcile, extractConsolidated } from "../lib/core/pipeline"
import { findBalanceBreaks, isExplainedByCryptoFees, toCsv } from "../lib/core/verification"
import { renderReport } from "./report"
import type { Status, Classification, ReportRow, ReportModel } from "./report"
import type { BankId } from "../lib/core/prompts"
import type { Transaction } from "../lib/core/types"

// pdfjs logs a harmless per-font line ("Ensure that the `standardFontDataUrl` API
// parameter is provided") when reading text without font data — we only need
// positions. Drop that specific noise; the harness's own output never contains it.
for (const ch of ["log", "warn"] as const) {
  const orig = console[ch].bind(console)
  console[ch] = (...a: unknown[]) => {
    if (String(a[0] ?? "").includes("standardFontDataUrl")) return
    orig(...a)
  }
}

// --- config ---------------------------------------------------------------

/** Where the input PDFs live (override with STATEMENTS_DIR for a different path). */
const STATEMENTS_DIR = process.env.STATEMENTS_DIR ?? join(process.cwd(), "statements")
/** Where results live (gitignored). */
const RECONCILE_DIR = join(process.cwd(), ".reconcile")
const BASELINE_PATH = join(RECONCILE_DIR, "baseline.json")
const LAST_RUN_PATH = join(RECONCILE_DIR, "last-run.json")
/** Human-readable CSV snapshot of the ACCEPTED rows, one file per statement. Stored
 * next to baseline.json (gitignored). Used to show a row-level diff on a regression. */
const SNAPSHOTS_DIR = join(RECONCILE_DIR, "snapshots")

interface BankConfig {
  bank: BankId
  dir: string // folder under STATEMENTS_DIR
  excludeDirs?: string[] // sub-paths (relative to dir, forward slashes) to skip
}

/** Banks with a deterministic parser. `revolut-consolidated` is a different layout
 * (multi-account) and lives in a sub-folder excluded from the plain `revolut` scan. */
const BANKS: BankConfig[] = [
  { bank: "revolut", dir: "Revolut", excludeDirs: ["consolidated statement"] },
  { bank: "revolut-consolidated", dir: "Revolut/consolidated statement" },
  { bank: "aib", dir: "AIB" },
  { bank: "boi", dir: "BOI" },
]

// --- result records -------------------------------------------------------
// (Status / Classification / ReportRow / ReportModel come from ./report.)

interface StandardRecord {
  bank: BankId
  kind: "standard"
  transactions: number
  status: Status
  discrepancyCents: number
  fingerprint: string
  error?: string
}
interface AccountRecord {
  label: string
  currency: string
  transactions: number
  status: Status
  discrepancyCents: number
  fingerprint: string
}
interface ConsolidatedRecord {
  bank: BankId
  kind: "consolidated"
  allReconciled: boolean
  accounts: AccountRecord[]
  error?: string
}
type StmtRecord = StandardRecord | ConsolidatedRecord

interface Baseline {
  generatedAt: string
  results: Record<string, StmtRecord> // keyed by path relative to STATEMENTS_DIR
}

// --- helpers --------------------------------------------------------------

/** Stable short hash of the extracted rows — detects ANY content change, even one
 * that still reconciles (a renamed description, a shuffled amount, etc.). */
function fingerprint(txs: Transaction[]): string {
  const shape = JSON.stringify(txs.map((t) => [t.date, t.description, t.debit, t.credit, t.balance]))
  return createHash("sha1").update(shape).digest("hex").slice(0, 12)
}

/** A statement's path relative to STATEMENTS_DIR, with forward slashes (stable key). */
function relKey(absPath: string): string {
  return relative(STATEMENTS_DIR, absPath).split(sep).join("/")
}

/** All *.pdf under `root`, recursive, skipping excluded sub-paths. */
function findPdfs(root: string, excludeDirs: string[] = []): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const rel = relative(root, full).split(sep).join("/")
        if (excludeDirs.some((ex) => rel === ex || rel.startsWith(ex + "/"))) continue
        walk(full)
      } else if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

function statusOf(reconciledPassed: boolean, txCount: number, data?: { transactions: Transaction[]; openingBalance: number; closingBalance: number; bank: string }): Status {
  if (txCount === 0) return "no-tx"
  if (reconciledPassed) return "pass"
  if (data && isExplainedByCryptoFees(findBalanceBreaks(data))) return "soft"
  return "fail"
}

/** Run one statement through the production code path → a comparable record PLUS a
 * human-readable CSV of the extracted rows (the snapshot, for the regression diff). */
async function processStatement(bank: BankId, absPath: string): Promise<{ record: StmtRecord; csv: string }> {
  const bytes = new Uint8Array(readFileSync(absPath))
  try {
    if (bank === "revolut-consolidated") {
      const c = await extractConsolidated(bytes)
      const record: StmtRecord = {
        bank,
        kind: "consolidated",
        allReconciled: c.allReconciled,
        accounts: c.accounts.map((a) => ({
          label: a.label,
          currency: a.currency,
          transactions: a.transactionCount,
          status: statusOf(a.reconciliation.passed, a.transactionCount),
          discrepancyCents: a.reconciliation.discrepancyCents,
          fingerprint: fingerprint(a.transactions),
        })),
      }
      // One CSV block per account (the snapshot is the whole multi-account document).
      const csv = c.accounts
        .map(
          (a) =>
            `# account: ${a.label} (${a.currency})\n` +
            toCsv({ bank: c.bank, openingBalance: a.openingBalance, closingBalance: a.closingBalance, transactions: a.transactions }),
        )
        .join("\n")
      return { record, csv }
    }
    // allowAiFallback:false → deterministic only; an unreadable layout stays
    // no-tx instead of triggering a (non-deterministic, paid) AI call.
    const r = await extractAndReconcile(bytes, { bank, allowAiFallback: false })
    const n = r.data.transactions.length
    const record: StmtRecord = {
      bank,
      kind: "standard",
      transactions: n,
      status: statusOf(r.reconciliation.passed, n, r.data),
      discrepancyCents: r.reconciliation.discrepancyCents,
      fingerprint: fingerprint(r.data.transactions),
    }
    return { record, csv: toCsv(r.data) }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (bank === "revolut-consolidated") {
      return { record: { bank, kind: "consolidated", allReconciled: false, accounts: [], error }, csv: "" }
    }
    return { record: { bank, kind: "standard", transactions: 0, status: "error", discrepancyCents: 0, fingerprint: "", error }, csv: "" }
  }
}

// --- diff vs baseline -----------------------------------------------------

/** A short human label for the reconciliation outcome of a record. */
function reconLabel(rec: StmtRecord): string {
  if (rec.kind === "consolidated") {
    if (rec.error) return "error"
    const parts = rec.accounts.map((a) => `${a.currency}:${a.status}`)
    return `${rec.allReconciled ? "all-ok" : "not-all"} [${parts.join(" ")}]`
  }
  return rec.status
}

/** A single status for a record (for the report's filter + summary cards). */
function rowStatus(rec: StmtRecord): Status {
  if (rec.kind === "standard") return rec.status
  if (rec.error) return "error"
  return rec.allReconciled ? "pass" : "fail"
}

function reconChanged(cur: StmtRecord, base: StmtRecord): boolean {
  return reconLabel(cur) !== reconLabel(base)
}

function contentChanged(cur: StmtRecord, base: StmtRecord): boolean {
  if (cur.kind !== base.kind) return true
  if (cur.kind === "standard" && base.kind === "standard") {
    return cur.fingerprint !== base.fingerprint || cur.transactions !== base.transactions
  }
  if (cur.kind === "consolidated" && base.kind === "consolidated") {
    const a = cur.accounts.map((x) => `${x.label}:${x.transactions}:${x.fingerprint}`).join("|")
    const b = base.accounts.map((x) => `${x.label}:${x.transactions}:${x.fingerprint}`).join("|")
    return a !== b
  }
  return true
}

function classify(cur: StmtRecord, base: StmtRecord | undefined): Classification {
  if (!base) return "NEW"
  if (reconChanged(cur, base)) return "CHANGED-RECON"
  if (contentChanged(cur, base)) return "CHANGED-CONTENT"
  return "UNCHANGED"
}

// --- CSV snapshots + row-level diff ---------------------------------------

/** Reference-CSV path for a statement key (mirrors the path; .pdf → .csv). */
function snapshotPath(key: string): string {
  return join(SNAPSHOTS_DIR, key.replace(/\.pdf$/i, "") + ".csv")
}

/** Print a compact, dependency-free row-level diff of two CSV snapshots: lines only
 * in the reference (−) and only in the current (+), capped. A changed row shows as a
 * matched −/+ pair; a pure reorder (same set, different order) is noted instead. */
function printCsvDiff(baseCsv: string, curCsv: string, cap = 15): void {
  const count = (csv: string) => {
    const m = new Map<string, number>()
    for (const l of csv.split("\n")) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const baseM = count(baseCsv)
  const curM = count(curCsv)
  const removed: string[] = []
  const added: string[] = []
  for (const [l, n] of baseM) for (let i = 0; i < n - (curM.get(l) ?? 0); i++) removed.push(l)
  for (const [l, n] of curM) for (let i = 0; i < n - (baseM.get(l) ?? 0); i++) added.push(l)
  if (removed.length === 0 && added.length === 0) {
    console.log(`      (rows reordered — same set, different order)`)
    return
  }
  console.log(`      diff: +${added.length} / -${removed.length} row(s) vs snapshot`)
  for (const l of removed.slice(0, cap)) console.log(`      - ${l}`)
  if (removed.length > cap) console.log(`      … ${removed.length - cap} more removed`)
  for (const l of added.slice(0, cap)) console.log(`      + ${l}`)
  if (added.length > cap) console.log(`      … ${added.length - cap} more added`)
}

// --- main -----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const updateBaseline = args.includes("--update-baseline")
  const openReport = args.includes("--open")
  const bankFilter = args.find((a) => !a.startsWith("--"))

  const banksToRun = bankFilter ? BANKS.filter((b) => b.bank === bankFilter) : BANKS
  if (banksToRun.length === 0) {
    console.error(`Unknown bank "${bankFilter}". Known: ${BANKS.map((b) => b.bank).join(", ")}`)
    process.exit(2)
  }

  const baseline: Baseline | null = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : null

  const current: Record<string, StmtRecord> = {}
  const reportRows: ReportRow[] = []
  const counts = { "CHANGED-RECON": 0, "CHANGED-CONTENT": 0, NEW: 0, UNCHANGED: 0, MISSING: 0, error: 0 }

  for (const cfg of banksToRun) {
    const root = join(STATEMENTS_DIR, cfg.dir)
    if (!existsSync(root)) {
      console.log(`\n${cfg.bank}: folder not found (${root}) — skipped`)
      continue
    }
    const pdfs = findPdfs(root, cfg.excludeDirs)
    console.log(`\n${cfg.bank}  (${pdfs.length} statement${pdfs.length === 1 ? "" : "s"})`)
    for (const pdf of pdfs) {
      const key = relKey(pdf)
      const { record: rec, csv } = await processStatement(cfg.bank, pdf)
      current[key] = rec
      const cls = classify(rec, baseline?.results[key])
      counts[cls]++
      if (rec.kind === "consolidated" && rec.error) counts.error++
      if (rec.kind === "standard" && rec.status === "error") counts.error++

      const mark =
        cls === "UNCHANGED" ? "        " : cls === "NEW" ? "[new]   " : cls === "CHANGED-CONTENT" ? "[~text] " : "[CHANGED]"
      const base = baseline?.results[key]
      const delta = cls === "CHANGED-RECON" && base ? `  (${reconLabel(base)} -> ${reconLabel(rec)})` : ""
      console.log(`  ${mark} ${reconLabel(rec).padEnd(28)} ${key}${delta}`)

      // CSV snapshot (the accepted rows) + row-level diff on regression.
      const snapPath = snapshotPath(key)
      const oldSnap = existsSync(snapPath) ? readFileSync(snapPath, "utf8") : null
      if ((cls === "CHANGED-CONTENT" || cls === "CHANGED-RECON") && oldSnap !== null && csv) {
        printCsvDiff(oldSnap, csv)
      }
      // Write the reference snapshot under the SAME policy as baseline.json:
      // a NEW statement, a missing snapshot (bootstrap already-accepted entries),
      // or an explicit --update-baseline. A CHANGED snapshot is NOT overwritten
      // otherwise, so it stays the reference until the change is consciously accepted.
      if (csv && (cls === "NEW" || oldSnap === null || updateBaseline)) {
        mkdirSync(dirname(snapPath), { recursive: true })
        writeFileSync(snapPath, csv)
      }

      reportRows.push({
        key,
        bank: cfg.bank,
        rowStatus: rowStatus(rec),
        classification: cls,
        transactions:
          rec.kind === "standard" ? rec.transactions : rec.accounts.reduce((s, a) => s + a.transactions, 0),
        discrepancyCents:
          rec.kind === "standard"
            ? rec.discrepancyCents
            : rec.accounts.reduce((s, a) => s + Math.abs(a.discrepancyCents), 0),
        accounts:
          rec.kind === "consolidated"
            ? rec.accounts.map((a) => ({ currency: a.currency, status: a.status, transactions: a.transactions }))
            : undefined,
        baseLabel: cls === "CHANGED-RECON" && base ? reconLabel(base) : undefined,
      })
    }
  }

  // MISSING: baseline entries for the banks we ran, with no current file.
  const ranBanks = new Set(banksToRun.map((b) => b.bank))
  const missing: string[] = []
  if (baseline) {
    for (const [key, rec] of Object.entries(baseline.results)) {
      if (ranBanks.has(rec.bank) && !(key in current)) {
        missing.push(key)
        counts.MISSING++
      }
    }
  }
  if (missing.length) {
    console.log(`\nMISSING (in baseline, no file now):`)
    for (const m of missing) console.log(`  [MISSING] ${m}`)
  }

  // Write the latest run (overwritten each time — no timestamped history).
  mkdirSync(RECONCILE_DIR, { recursive: true })
  writeFileSync(LAST_RUN_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), bankFilter: bankFilter ?? "all", results: current }, null, 2))

  // Write the human-friendly HTML report (always reflects the latest run).
  const reportModel: ReportModel = {
    generatedAt: new Date().toISOString(),
    bankFilter: bankFilter ?? "all",
    rows: reportRows,
    missing: missing.map((key) => ({
      key,
      bank: baseline!.results[key].bank,
      baseLabel: reconLabel(baseline!.results[key]),
    })),
  }
  const reportPath = join(RECONCILE_DIR, "report.html")
  writeFileSync(reportPath, renderReport(reportModel))

  // Summary.
  const total = Object.keys(current).length
  console.log(
    `\nSummary: ${total} statement(s) | ${counts.UNCHANGED} unchanged, ${counts.NEW} new, ` +
      `${counts["CHANGED-CONTENT"]} content-changed, ${counts["CHANGED-RECON"]} recon-changed, ` +
      `${counts.MISSING} missing, ${counts.error} error`,
  )
  console.log(`Run log: ${relative(process.cwd(), LAST_RUN_PATH)}`)
  console.log(`Report:  ${pathToFileURL(reportPath).href}`)

  // Optionally open the report in the default browser (`--open`).
  if (openReport) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open"
    const cmdArgs = process.platform === "win32" ? ["/c", "start", "", reportPath] : [reportPath]
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref()
  }

  // Baseline write policy:
  //  - NEW statements are ALWAYS recorded (first time seen → they become the
  //    reference; there's nothing to regress from yet).
  //  - CHANGED / MISSING entries are only applied with --update-baseline, so an
  //    actual change is a conscious decision, never silently absorbed.
  const baseResults = baseline?.results ?? {}
  const merged: Record<string, StmtRecord> = { ...baseResults }
  let dirty = false
  for (const [key, rec] of Object.entries(current)) {
    if (!(key in baseResults)) {
      merged[key] = rec // NEW → auto-record
      dirty = true
    } else if (updateBaseline) {
      merged[key] = rec // existing entry → only refreshed on explicit accept
      dirty = true
    }
  }
  if (updateBaseline) {
    for (const m of missing) {
      delete merged[m]
      dirty = true
    }
  }
  if (dirty) {
    mkdirSync(RECONCILE_DIR, { recursive: true })
    writeFileSync(BASELINE_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results: merged }, null, 2))
  }

  if (!baseline) {
    console.log(`Baseline created: ${relative(process.cwd(), BASELINE_PATH)} (this run is now the reference).`)
  } else if (updateBaseline) {
    console.log(`Baseline updated.`)
  } else {
    if (counts.NEW) console.log(`Recorded ${counts.NEW} new statement(s) into the baseline.`)
    if (counts["CHANGED-RECON"] || counts["CHANGED-CONTENT"] || counts.MISSING)
      console.log(`Existing entries kept. Re-run with --update-baseline to accept the changes above.`)
  }

  // Non-zero exit on a meaningful change so scripts/CI notice.
  const regressed = counts["CHANGED-RECON"] > 0 || counts.MISSING > 0 || counts.error > 0
  process.exit(regressed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
