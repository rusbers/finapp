/**
 * PDF utilities — splitting a PDF into smaller page-chunks.
 *
 * Why: large statements (many pages, many transactions) take too long for a
 * single AI call and time out on serverless. We split the PDF into small chunks
 * of pages, extract them in parallel, then merge. The client uploads one file
 * and sees nothing of this.
 *
 * pdf-lib is pure JavaScript (no native deps), so it works on Vercel/serverless.
 */

import { PDFDocument } from "pdf-lib"

/**
 * Split a PDF (bytes) into chunks of at most `pagesPerChunk` pages each.
 * Returns an array of base64-encoded PDFs, in original page order.
 */
export async function splitPdfIntoChunks(
  pdfBytes: Uint8Array,
  pagesPerChunk: number,
): Promise<string[]> {
  let source: PDFDocument
  try {
    source = await PDFDocument.load(pdfBytes)
  } catch {
    throw new Error("Could not read the PDF (it may be corrupted or password-protected).")
  }

  const totalPages = source.getPageCount()
  const chunks: string[] = []

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages)
    const indices: number[] = []
    for (let i = start; i < end; i++) indices.push(i)

    const chunkDoc = await PDFDocument.create()
    const copiedPages = await chunkDoc.copyPages(source, indices)
    copiedPages.forEach((p) => chunkDoc.addPage(p))

    const bytes = await chunkDoc.save()
    chunks.push(Buffer.from(bytes).toString("base64"))
  }

  return chunks
}

/** Count the pages in a PDF (without splitting). */
export async function countPdfPages(pdfBytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdfBytes)
  return doc.getPageCount()
}
