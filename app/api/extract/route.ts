/**
 * Extraction endpoint: POST /api/extract
 * Thin layer: parse the uploaded PDF + options, call the pipeline, return result.
 * All business logic lives in lib/core/ — this endpoint just wires it to HTTP.
 *
 * Consumed by the web app, a future public API, and future mobile — all via the
 * same endpoint. The logic is never duplicated.
 */

import { NextRequest, NextResponse } from "next/server"
import { extractAndReconcile, extractAndReconcileMany, extractConsolidated, extractRevolut } from "@/lib/core/pipeline"
import { isAllowedModel } from "@/lib/core/config"
import { BANK_LABELS, type BankId } from "@/lib/core/prompts"
import { categorizeTransactions } from "@/lib/core/categorization"
import type { Transaction } from "@/lib/core/types"
import { strings } from "@/lib/strings"

// This route uses Buffer and makes a slow AI call, so it runs on the Node.js
// runtime (the default) and is allowed extra time for the model to respond.
export const runtime = "nodejs"
export const maxDuration = 60 // seconds (relevant on serverless deploys)

const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15 MB per-file upload guard
const MAX_FILES = 24 // sanity cap on how many statements to combine at once

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()

    // Accept both a single "file" and multiple "files" (the UI sends "files").
    const multi = formData.getAll("files").filter((f): f is File => f instanceof File)
    const single = formData.get("file")
    const uploaded: File[] = multi.length > 0 ? multi : single instanceof File ? [single] : []

    if (uploaded.length === 0) {
      return NextResponse.json({ error: strings.errorNoFile }, { status: 400 })
    }
    if (uploaded.length > MAX_FILES) {
      return NextResponse.json({ error: strings.errorTooManyFiles }, { status: 413 })
    }
    for (const f of uploaded) {
      if (f.type !== "application/pdf") {
        return NextResponse.json({ error: strings.errorNotPdf }, { status: 400 })
      }
      if (f.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: strings.errorTooLarge }, { status: 413 })
      }
    }

    // Read options from the request (sent by the UI). Validate model names
    // against the allow-list; ignore anything invalid (fall back to defaults).
    const rawPrimary = formData.get("primaryModel")
    const rawFallback = formData.get("fallbackModel")
    const rawEnableFallback = formData.get("enableFallback")

    const primaryModel = isAllowedModel(rawPrimary) ? rawPrimary : undefined
    const fallbackModel = isAllowedModel(rawFallback) ? rawFallback : undefined
    const enableFallback = rawEnableFallback != null ? rawEnableFallback === "true" : undefined

    // Validate the bank against the known set; fall back to "generic".
    const rawBank = formData.get("bank")
    const bank: BankId =
      typeof rawBank === "string" && rawBank in BANK_LABELS ? (rawBank as BankId) : "generic"

    const options = { primaryModel, fallbackModel, enableFallback, bank }

    // Optional categorization step — runs AFTER reconciliation, only when the UI
    // toggle is on (it costs AI). Rules catch most rows for free; AI handles the
    // rest (unique descriptions, in parallel). It mutates `category` in place and
    // NEVER affects reconciliation.
    const categorize = formData.get("categorize") === "true"
    const maybeCategorize = async (txArrays: Transaction[][]) =>
      categorize
        ? await categorizeTransactions(txArrays.flat(), { useAi: true, model: primaryModel })
        : null

    // Revolut consolidated ("Custom") statement → one PDF with several current
    // accounts, each reconciled separately. Its own parser/shape.
    if (bank === "revolut-consolidated") {
      const pdfBytes = new Uint8Array(await uploaded[0].arrayBuffer())
      const consolidated = await extractConsolidated(pdfBytes)
      const categorization = await maybeCategorize(consolidated.accounts.map((a) => a.transactions))
      return NextResponse.json({ consolidated, fileName: uploaded[0].name, categorization })
    }

    // Single file → single-statement result (unchanged shape). Revolut goes through
    // the smart entry, which returns a per-currency (consolidated-shaped) result for
    // the rare PDF that bundles current accounts in several currencies.
    if (uploaded.length === 1) {
      const pdfBytes = new Uint8Array(await uploaded[0].arrayBuffer())
      if (bank === "revolut") {
        const r = await extractRevolut(pdfBytes, options)
        if (r.kind === "multi") {
          const categorization = await maybeCategorize(r.consolidated.accounts.map((a) => a.transactions))
          return NextResponse.json({ consolidated: r.consolidated, fileName: uploaded[0].name, categorization })
        }
        const categorization = await maybeCategorize([r.result.data.transactions])
        return NextResponse.json({ ...r.result, fileName: uploaded[0].name, categorization })
      }
      const result = await extractAndReconcile(pdfBytes, options)
      const categorization = await maybeCategorize([result.data.transactions])
      return NextResponse.json({ ...result, fileName: uploaded[0].name, categorization })
    }

    // Multiple files → chain + combine + reconcile across the whole series.
    const filesWithBytes = await Promise.all(
      uploaded.map(async (f) => ({
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    )
    const multiResult = await extractAndReconcileMany(filesWithBytes, options)
    const categorization = await maybeCategorize([multiResult.result.data.transactions])

    // Flatten so the UI gets the same top-level result fields, plus multi extras.
    // The file label reflects the files actually used (unique = perFile), so ignored
    // duplicates aren't counted.
    const usedCount = multiResult.perFile.length
    return NextResponse.json({
      ...multiResult.result,
      fileName: `${usedCount} file${usedCount === 1 ? "" : "s"}`,
      perFile: multiResult.perFile,
      gaps: multiResult.gaps,
      fullyChained: multiResult.fullyChained,
      duplicates: multiResult.duplicates,
      categorization,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : strings.errorUnknown
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
