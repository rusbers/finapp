/**
 * Extraction endpoint: POST /api/extract
 * Thin layer: parse the uploaded PDF + options, call the pipeline, return result.
 * All business logic lives in lib/core/ — this endpoint just wires it to HTTP.
 *
 * Consumed by the web app, a future public API, and future mobile — all via the
 * same endpoint. The logic is never duplicated.
 */

import { NextRequest, NextResponse } from "next/server"
import { extractAndReconcile } from "@/lib/core/pipeline"
import { isAllowedModel } from "@/lib/core/config"
import { strings } from "@/lib/strings"

// This route uses Buffer and makes a slow AI call, so it runs on the Node.js
// runtime (the default) and is allowed extra time for the model to respond.
export const runtime = "nodejs"
export const maxDuration = 60 // seconds (relevant on serverless deploys)

const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15 MB upload guard

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: strings.errorNoFile }, { status: 400 })
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: strings.errorNotPdf }, { status: 400 })
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: strings.errorTooLarge }, { status: 413 })
    }

    // Read options from the request (sent by the UI). Validate model names
    // against the allow-list; ignore anything invalid (fall back to defaults).
    const rawPrimary = formData.get("primaryModel")
    const rawFallback = formData.get("fallbackModel")
    const rawEnableFallback = formData.get("enableFallback")

    const primaryModel = isAllowedModel(rawPrimary) ? rawPrimary : undefined
    const fallbackModel = isAllowedModel(rawFallback) ? rawFallback : undefined
    const enableFallback = rawEnableFallback != null ? rawEnableFallback === "true" : undefined

    // PDF -> base64 (on the server)
    const bytes = Buffer.from(await file.arrayBuffer())
    const pdfBase64 = bytes.toString("base64")

    // Extraction cascade + reconciliation + per-model stats (all in lib/core)
    const result = await extractAndReconcile(pdfBase64, {
      primaryModel,
      fallbackModel,
      enableFallback,
    })

    return NextResponse.json({ ...result, fileName: file.name })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : strings.errorUnknown
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
