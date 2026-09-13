/**
 * Recent reconciliations — the last few results, saved in THIS browser (BACKLOG 5.1, v1).
 *
 * First slice of persistence: no accounts, no server. A record is a WORKING SET: the API
 * result, the user's work on it (category edits + verified ticks) AND the inputs it was
 * made from (the PDFs, bank, labels, expenses file), so a saved reconciliation can be
 * reopened, extended with one more statement, trimmed, and reconciled again. Later
 * versions move the same records to a database.
 *
 * Storage is IndexedDB, not localStorage: a full-year Revolut statement is ~0.5 MB as
 * JSON, a multi-account client several of those, and the PDFs themselves are megabytes —
 * localStorage's ~5 MB origin quota (shared with the settings store) could never hold
 * that, and a QuotaExceededError would silently lose the save. IndexedDB quotas are a
 * share of free disk. Hand-written wrapper, no dependency.
 *
 * Two object stores keyed by the same id: `recent` (record + result + edits, what the
 * list reads with one getAll) and `inputs` (the file bytes — read only when a record is
 * opened, so listing never loads megabytes of PDFs).
 *
 * Every call is best-effort: when IndexedDB is unavailable (private mode, storage
 * blocked) the list is empty and saves are no-ops — never an error in the UI.
 * Browser-only (uses `indexedDB`, `File`), so it lives in `app/`, not `lib/core/`.
 */

import type { ApiResponse } from "./api-types"
import type { BankId } from "@/lib/core/prompts"
import { findBalanceBreaks, isExplainedByCryptoFees } from "@/lib/core/verification"

export const RECENT_LIMIT = 5

const DB_NAME = "statement-check"
const DB_VERSION = 2 // 1: `recent` only · 2: + `inputs`
const STORE = "recent"
const INPUTS = "inputs"

export type RecentVerdict = "pass" | "soft" | "fail"

export interface RecentSummary {
  verdict: RecentVerdict
  transactions: number
  accounts: number
  files: number // statement PDFs the record was made from (0 for a CSV re-import)
  periodStart: string | null
  periodEnd: string | null
}

export interface RecentRecord {
  id: string
  savedAt: number // Date.now() — last saved/updated
  name: string // defaults to the result's fileName; the user can rename it
  summary: RecentSummary
  result: ApiResponse
  catOverrides: Record<string, string>
  verified: number[] // the page's Set, stored as a plain array
}

/** A file's bytes + identity, as stored (ArrayBuffer clones everywhere; a File would not). */
export interface StoredFile {
  name: string
  type: string
  bytes: ArrayBuffer
}

/** Everything the upload card held when the record was (last) reconciled. */
export interface RecentInputs {
  mode: "pdf" | "csv"
  bank: BankId // primary account
  primaryLabel: string
  files: StoredFile[] // primary account PDFs — or the CSV/xlsx in csv mode
  extraAccounts: { bank: BankId; label: string; files: StoredFile[] }[]
  expenses: StoredFile | null
  pastedText: string | null // csv mode: pasted rows instead of a file
}

export async function toStoredFile(file: File): Promise<StoredFile> {
  return { name: file.name, type: file.type, bytes: await file.arrayBuffer() }
}

export function toFile(sf: StoredFile): File {
  return new File([sf.bytes], sf.name, { type: sf.type })
}

/* ------------------------------------------------------------------ *
 * Summary — what the list shows without opening the record.
 * ------------------------------------------------------------------ */

/** The same verdict rule the page renders: a single statement that fails ONLY by a
 * known bank-side inconsistency (crypto spreads) is "soft", not a failure. `files` is
 * the caller's (the result doesn't know how many PDFs it came from). */
export function summarize(result: ApiResponse, files: number): RecentSummary {
  let verdict: RecentVerdict
  let accounts: number
  let rows: { date: string }[]
  if (result.multi) {
    verdict = result.multi.allReconciled ? "pass" : "fail"
    accounts = result.multi.accounts.length
    rows = result.multi.accounts.flatMap((a) => a.transactions)
  } else if (result.consolidated) {
    verdict = result.consolidated.allReconciled ? "pass" : "fail"
    accounts = result.consolidated.accounts.length
    rows = result.consolidated.accounts.flatMap((a) => a.transactions)
  } else {
    const data = result.data
    rows = data?.transactions ?? []
    accounts = 1
    if (result.reconciliation.passed) verdict = "pass"
    else if (data && isExplainedByCryptoFees(findBalanceBreaks(data))) verdict = "soft"
    else verdict = "fail"
  }
  const dates = rows.map((t) => t.date).filter(Boolean).sort()
  return {
    verdict,
    transactions: rows.length,
    accounts,
    files,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
  }
}

/* ------------------------------------------------------------------ *
 * IndexedDB plumbing — one database, two object stores keyed by id.
 * ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable"))
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" }).createIndex("savedAt", "savedAt")
        }
        if (!db.objectStoreNames.contains(INPUTS)) {
          db.createObjectStore(INPUTS, { keyPath: "id" })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error("IndexedDB blocked"))
    })
    // A failed open must not poison every later call — let the next one retry.
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

/** Run `fn` inside one transaction over the given stores; resolves when it completes. */
function withStores<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(stores, mode)
        const out = fn(tx)
        tx.oncomplete = () => resolve(out)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/* ------------------------------------------------------------------ *
 * Public API — all fail-soft.
 * ------------------------------------------------------------------ */

/** Every saved record, newest first — WITHOUT file bytes. Empty when storage is unavailable. */
export async function listRecent(): Promise<RecentRecord[]> {
  try {
    const db = await openDb()
    const store = db.transaction(STORE, "readonly").objectStore(STORE)
    const all = await requestResult(store.getAll() as IDBRequest<RecentRecord[]>)
    return all.sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

/** The inputs a record was made from, or null (storage unavailable, or a record saved
 * before inputs were stored). */
export async function loadInputs(id: string): Promise<RecentInputs | null> {
  try {
    const db = await openDb()
    const store = db.transaction(INPUTS, "readonly").objectStore(INPUTS)
    const row = await requestResult(store.get(id) as IDBRequest<({ id: string } & RecentInputs) | undefined>)
    if (!row) return null
    const { id: _id, ...inputs } = row
    void _id
    return inputs
  } catch {
    return null
  }
}

/** Add a record (+ its inputs) and trim the store to RECENT_LIMIT (oldest dropped, with
 * their inputs). Returns the saved record, or null when storage is unavailable (the
 * caller then just isn't autosaving). */
export async function saveRecent(
  rec: Omit<RecentRecord, "id" | "savedAt">,
  inputs: RecentInputs | null,
): Promise<RecentRecord | null> {
  const full: RecentRecord = { ...rec, id: newId(), savedAt: Date.now() }
  try {
    await withStores([STORE, INPUTS], "readwrite", (tx) => {
      tx.objectStore(STORE).put(full)
      if (inputs) tx.objectStore(INPUTS).put({ id: full.id, ...inputs })
    })
    const all = await listRecent()
    const excess = all.slice(RECENT_LIMIT)
    if (excess.length > 0) {
      await withStores([STORE, INPUTS], "readwrite", (tx) => {
        for (const r of excess) {
          tx.objectStore(STORE).delete(r.id)
          tx.objectStore(INPUTS).delete(r.id)
        }
      })
    }
    return full
  } catch {
    return null
  }
}

/** Merge a patch into a saved record (name, edits, ticks — or, on a re-run, the new
 * result/summary/savedAt) and, when given, replace its inputs. No-op if the record is
 * missing. */
export async function updateRecent(
  id: string,
  patch: Partial<Omit<RecentRecord, "id">>,
  inputs?: RecentInputs | null,
): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction([STORE, INPUTS], "readwrite")
    const store = tx.objectStore(STORE)
    const existing = await requestResult(store.get(id) as IDBRequest<RecentRecord | undefined>)
    if (existing) {
      store.put({ ...existing, ...patch })
      if (inputs) tx.objectStore(INPUTS).put({ id, ...inputs })
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // best-effort
  }
}

export async function deleteRecent(id: string): Promise<void> {
  try {
    await withStores([STORE, INPUTS], "readwrite", (tx) => {
      tx.objectStore(STORE).delete(id)
      tx.objectStore(INPUTS).delete(id)
    })
  } catch {
    // best-effort
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
