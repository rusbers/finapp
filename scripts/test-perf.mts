/**
 * Performance baseline for the DETERMINISTIC extraction path (lib/core/pipeline).
 *
 * The recent UI/route work (Financial-period slicing, the "#" column, per-column
 * sort/filter, Account-column stamping) sits OUTSIDE extraction, so it must not
 * change these numbers. This script times `extractAndReconcile` (no AI, no network)
 * on a few representative real statements and compares the average against a saved
 * baseline, flagging any speed regression — the timing counterpart to
 * `npm run test:statements` (which guards CORRECTNESS, not speed).
 *
 * Like the other harnesses it reads real PDFs from `statements/` (gitignored client
 * data), so it is a LOCAL dev artifact — missing files are skipped, never an error.
 *
 * Usage:
 *   npm run test:perf              time + compare against .reconcile/perf-baseline.json
 *   npm run test:perf -- --update  (re)write the baseline from this run
 *
 * Exit code: 1 if a case regressed (or reconciliation failed); 0 otherwise.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { extractAndReconcile } from "../lib/core/pipeline"
import type { BankId } from "../lib/core/prompts"

type Case = { name: string; bank: BankId; file: string }

// Representative across banks and sizes; the Revolut full-year case (thousands of
// rows) is the heaviest and the most sensitive to any parser-path regression.
const CASES: Case[] = [
  { name: "revolut-fullyear", bank: "revolut", file: "statements/Revolut/en/7/account-statement_2025-01-01_2025-12-31_en_795638.pdf" },
  { name: "boi-large",        bank: "boi",     file: "statements/BOI/3 - anormal statement/4.pdf" },
  { name: "boi-mid",          bank: "boi",     file: "statements/BOI/BOI/14/BOI 2024.pdf" },
  { name: "aib-small",        bank: "aib",     file: "statements/AIB/AIB/9/9th August 2024 (5).PDF" },
]

const RUNS = 3 // measured runs after a warm-up (steady-state, first pdfjs import excluded)
const BASELINE = ".reconcile/perf-baseline.json"
const REGRESS_PCT = 25 // flag when the average is this % slower than baseline...
const REGRESS_FLOOR_MS = 50 // ...AND the absolute increase exceeds this (ignore noise on tiny cases)

const update = process.argv.includes("--update")

type Timing = { avgMs: number; minMs: number; txCount: number; passed: boolean }

async function timeCase(c: Case): Promise<Timing | null> {
  if (!existsSync(c.file)) return null
  const bytes = new Uint8Array(readFileSync(c.file))
  // Warm-up (excluded): pays the one-time pdfjs load so we measure steady-state parse.
  await extractAndReconcile(new Uint8Array(bytes), { bank: c.bank, allowAiFallback: false })
  const runs: number[] = []
  let txCount = 0
  let passed = false
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    const r = await extractAndReconcile(new Uint8Array(bytes), { bank: c.bank, allowAiFallback: false })
    runs.push(performance.now() - t)
    txCount = r.data.transactions.length
    passed = r.reconciliation.passed
  }
  return {
    avgMs: runs.reduce((a, b) => a + b, 0) / runs.length,
    minMs: Math.min(...runs),
    txCount,
    passed,
  }
}

type Baseline = Record<string, { avgMs: number; txCount: number }>
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {}

let regressions = 0
let skipped = 0
const fresh: Baseline = {}

console.log(`Perf — deterministic path (${RUNS} runs each, warm process)\n`)
console.log("case".padEnd(20) + "tx".padStart(7) + "  avg".padStart(10) + "  min".padStart(10) + "  vs base".padStart(12) + "  status")
console.log("-".repeat(72))

for (const c of CASES) {
  const t = await timeCase(c)
  if (!t) {
    skipped += 1
    console.log(c.name.padEnd(20) + "  (file missing — skipped)")
    continue
  }
  fresh[c.name] = { avgMs: Math.round(t.avgMs), txCount: t.txCount }

  const base = baseline[c.name]
  let vs = "     —"
  let status = update || !base ? "baseline" : "ok"
  if (base) {
    const deltaMs = t.avgMs - base.avgMs
    const pct = (deltaMs / base.avgMs) * 100
    vs = `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`
    if (!update && pct > REGRESS_PCT && deltaMs > REGRESS_FLOOR_MS) {
      status = "REGRESSION"
      regressions += 1
    }
  }
  if (!t.passed) {
    status = "RECON-FAIL"
    regressions += 1
  }

  console.log(
    c.name.padEnd(20) +
      String(t.txCount).padStart(7) +
      `${t.avgMs.toFixed(0)}ms`.padStart(10) +
      `${t.minMs.toFixed(0)}ms`.padStart(10) +
      vs.padStart(12) +
      "  " +
      status,
  )
}

if (update || Object.keys(baseline).length === 0) {
  mkdirSync(dirname(BASELINE), { recursive: true })
  // Keep any baseline entries for cases not run this time (e.g. a file was missing).
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, ...fresh }, null, 2))
  console.log(`\nBaseline written → ${BASELINE}`)
}

console.log(
  `\n${skipped ? `${skipped} skipped. ` : ""}` +
    (regressions === 0
      ? "No performance regressions."
      : `${regressions} regression(s)/failure(s) — see above.`),
)
process.exit(regressions === 0 ? 0 : 1)
