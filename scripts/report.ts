/**
 * Self-contained HTML report for the statements regression harness.
 *
 * `renderReport(model)` returns a complete HTML document (inline CSS + a little
 * vanilla JS for filtering — no dependencies, no build step). The harness writes
 * it to `.reconcile/report.html` after each run; open it in a browser to SEE the
 * results: a colour-coded, filterable table plus summary cards. It is a dev/local
 * artifact only — gitignored, never part of the Next app or production.
 */

import type { BankId } from "../lib/core/prompts"

export type Status = "pass" | "soft" | "fail" | "no-tx" | "error"
export type Classification = "NEW" | "UNCHANGED" | "CHANGED-RECON" | "CHANGED-CONTENT" | "MISSING"

/** One flattened, render-ready row (the harness maps its records to these). */
export interface ReportRow {
  key: string // statement path, relative to the statements root
  bank: BankId
  rowStatus: Status // single status used for filtering + summary
  classification: Classification
  transactions: number
  discrepancyCents: number
  accounts?: { currency: string; status: Status; transactions: number }[] // consolidated only
  baseLabel?: string // previous reconciliation label, shown when CHANGED-RECON
}

export interface ReportModel {
  generatedAt: string
  bankFilter: string
  rows: ReportRow[]
  missing: { key: string; bank: BankId; baseLabel: string }[]
}

const STATUS_ORDER: Status[] = ["pass", "soft", "fail", "no-tx", "error"]
const DIFF_ORDER: Classification[] = ["UNCHANGED", "NEW", "CHANGED-CONTENT", "CHANGED-RECON", "MISSING"]

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function money(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** A coloured status pill. */
function statusPill(status: Status): string {
  const sym = status === "pass" ? "✓" : status === "soft" ? "≈" : status === "fail" ? "✗" : status === "no-tx" ? "∅" : "⚠"
  return `<span class="pill s-${status}">${sym} ${status}</span>`
}

/** The "vs baseline" tag. */
function diffTag(cls: Classification, baseLabel?: string): string {
  if (cls === "UNCHANGED") return `<span class="tag unchanged">unchanged</span>`
  if (cls === "NEW") return `<span class="tag new">new</span>`
  if (cls === "CHANGED-CONTENT") return `<span class="tag content">content changed</span>`
  if (cls === "MISSING") return `<span class="tag missing">missing</span>`
  return `<span class="tag recon">recon changed${baseLabel ? ` (was ${esc(baseLabel)})` : ""}</span>`
}

function summaryCounts(rows: ReportRow[]) {
  const status: Record<Status, number> = { pass: 0, soft: 0, fail: 0, "no-tx": 0, error: 0 }
  const diff: Record<Classification, number> = { NEW: 0, UNCHANGED: 0, "CHANGED-RECON": 0, "CHANGED-CONTENT": 0, MISSING: 0 }
  for (const r of rows) {
    status[r.rowStatus]++
    diff[r.classification]++
  }
  return { status, diff }
}

export function renderReport(model: ReportModel): string {
  const { status, diff } = summaryCounts(model.rows)
  diff.MISSING += model.missing.length

  const banks = [...new Set(model.rows.map((r) => r.bank))].sort()

  const statusCards = STATUS_ORDER.map(
    (s) => `<div class="card s-${s}"><b>${status[s]}</b><span>${s}</span></div>`,
  ).join("")
  const diffCards = DIFF_ORDER.map((d) => {
    const n = d === "MISSING" ? diff.MISSING : diff[d]
    if (n === 0 && d !== "CHANGED-RECON") return ""
    return `<div class="card d-${d}"><b>${n}</b><span>${d.toLowerCase().replace("-", " ")}</span></div>`
  }).join("")

  const bankOptions = ["<option value=''>all banks</option>", ...banks.map((b) => `<option value='${esc(b)}'>${esc(b)}</option>`)].join("")

  const bodyRows = model.rows
    .map((r) => {
      const accounts = r.accounts
        ? `<div class="accts">${r.accounts.map((a) => `<span class="chip s-${a.status}">${esc(a.currency)} ${a.status === "pass" ? "✓" : a.status === "no-tx" ? "∅" : "✗"}</span>`).join("")}</div>`
        : ""
      const disc = r.discrepancyCents !== 0 ? `<span class="disc">${money(r.discrepancyCents)}</span>` : ""
      return `<tr class="row r-${r.classification}" data-status="${r.rowStatus}" data-bank="${esc(r.bank)}" data-key="${esc(r.key.toLowerCase())}">
        <td>${statusPill(r.rowStatus)}</td>
        <td class="path">${esc(r.key)}${accounts}</td>
        <td class="bank">${esc(r.bank)}</td>
        <td class="num">${r.transactions}</td>
        <td class="num">${disc}</td>
        <td>${diffTag(r.classification, r.baseLabel)}</td>
      </tr>`
    })
    .join("\n")

  const missingRows = model.missing
    .map(
      (m) => `<tr class="row r-MISSING" data-status="error" data-bank="${esc(m.bank)}" data-key="${esc(m.key.toLowerCase())}">
        <td><span class="pill s-error">⚠ gone</span></td>
        <td class="path">${esc(m.key)}</td>
        <td class="bank">${esc(m.bank)}</td>
        <td class="num">—</td>
        <td class="num"></td>
        <td>${diffTag("MISSING")}${m.baseLabel ? ` <span class="muted">was ${esc(m.baseLabel)}</span>` : ""}</td>
      </tr>`,
    )
    .join("\n")

  const total = model.rows.length + model.missing.length

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Statement reconciliation report</title>
<style>
  :root {
    --ink:#1b1f24; --ink-soft:#5b6470; --line:#e6e8eb; --bg:#f6f7f9; --card:#fff;
    --pass:#0a7d32; --pass-bg:#e7f5ec; --soft:#8a6d0b; --soft-bg:#fbf3da;
    --fail:#c0322b; --fail-bg:#fbeae9; --notx:#6b7280; --notx-bg:#f0f1f3;
    --error:#7a1f6a; --error-bg:#f6e9f4; --blue:#1d4ed8; --blue-bg:#e8eefc;
  }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 20px 64px; }
  h1 { font-size:20px; margin:0 0 2px; }
  .meta { color:var(--ink-soft); font-size:13px; margin-bottom:18px; }
  .cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 14px; min-width:84px; display:flex; flex-direction:column; }
  .card b { font-size:20px; line-height:1.1; }
  .card span { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); }
  .card.s-pass b{color:var(--pass)} .card.s-soft b{color:var(--soft)} .card.s-fail b{color:var(--fail)}
  .card.s-no-tx b{color:var(--notx)} .card.s-error b{color:var(--error)}
  .card.d-CHANGED-RECON{border-color:var(--fail); } .card.d-CHANGED-RECON b{color:var(--fail)}
  .card.d-NEW b{color:var(--blue)} .card.d-MISSING b{color:var(--fail)}
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; position:sticky; top:0; background:var(--bg); padding:10px 0; margin-bottom:6px; z-index:5; border-bottom:1px solid var(--line); }
  .bar button { border:1px solid var(--line); background:#fff; border-radius:999px; padding:5px 12px; font-size:13px; cursor:pointer; color:var(--ink-soft); }
  .bar button.active { background:var(--ink); color:#fff; border-color:var(--ink); }
  .bar select, .bar input { border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:13px; }
  .bar input { flex:1; min-width:160px; }
  .count { color:var(--ink-soft); font-size:13px; margin-left:auto; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  thead th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); padding:10px 14px; background:#fafbfc; border-bottom:1px solid var(--line); }
  tbody td { padding:9px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
  tbody tr:last-child td { border-bottom:0; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.path { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; word-break:break-all; }
  td.bank { color:var(--ink-soft); }
  tr.r-CHANGED-RECON { background:var(--fail-bg); }
  tr.r-MISSING { background:var(--fail-bg); }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
  .s-pass{ background:var(--pass-bg); color:var(--pass);} .s-soft{ background:var(--soft-bg); color:var(--soft);}
  .s-fail{ background:var(--fail-bg); color:var(--fail);} .s-no-tx{ background:var(--notx-bg); color:var(--notx);}
  .s-error{ background:var(--error-bg); color:var(--error);}
  .accts { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
  .chip { font-size:11px; padding:1px 7px; border-radius:6px; font-family:system-ui; }
  .tag { font-size:11.5px; padding:2px 8px; border-radius:6px; white-space:nowrap; }
  .tag.unchanged{ color:var(--ink-soft); } .tag.new{ background:var(--blue-bg); color:var(--blue);}
  .tag.content{ background:var(--soft-bg); color:var(--soft);} .tag.recon{ background:var(--fail); color:#fff;}
  .tag.missing{ background:var(--fail); color:#fff;}
  .disc{ color:var(--fail); font-weight:600; }
  .muted{ color:var(--ink-soft); font-size:12px; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Statement reconciliation report</h1>
  <div class="meta">Run ${esc(model.generatedAt)} · scope: <b>${esc(model.bankFilter)}</b> · ${total} statement(s)</div>

  <div class="cards">${statusCards}</div>
  <div class="cards">${diffCards}</div>

  <div class="bar">
    <button data-f="all" class="active">all</button>
    ${STATUS_ORDER.map((s) => `<button data-f="${s}">${s}</button>`).join("")}
    <button data-f="changed">changed</button>
    <select id="bank">${bankOptions}</select>
    <input id="search" type="search" placeholder="filter by path…" />
    <span class="count" id="count"></span>
  </div>

  <table>
    <thead><tr><th>Status</th><th>Statement</th><th>Bank</th><th>Tx</th><th>Δ</th><th>vs baseline</th></tr></thead>
    <tbody id="rows">
${bodyRows}
${missingRows}
    </tbody>
  </table>
</div>

<script>
  var statusFilter = "all";
  var rows = Array.prototype.slice.call(document.querySelectorAll("#rows tr"));
  var bankSel = document.getElementById("bank");
  var search = document.getElementById("search");
  var countEl = document.getElementById("count");
  function apply() {
    var bank = bankSel.value;
    var q = search.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (tr) {
      var st = tr.getAttribute("data-status");
      var isChanged = tr.className.indexOf("r-CHANGED-RECON") >= 0 || tr.className.indexOf("r-MISSING") >= 0;
      var okStatus = statusFilter === "all" || (statusFilter === "changed" ? isChanged : st === statusFilter);
      var okBank = !bank || tr.getAttribute("data-bank") === bank;
      var okSearch = !q || tr.getAttribute("data-key").indexOf(q) >= 0;
      var show = okStatus && okBank && okSearch;
      tr.classList.toggle("hidden", !show);
      if (show) shown++;
    });
    countEl.textContent = shown + " shown";
  }
  document.querySelectorAll(".bar button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".bar button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      statusFilter = b.getAttribute("data-f");
      apply();
    });
  });
  bankSel.addEventListener("change", apply);
  search.addEventListener("input", apply);
  apply();
</script>
</body>
</html>
`
}
