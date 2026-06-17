/**
 * Lazy loader for pdfjs-dist, hardened for the serverless (Vercel) runtime.
 *
 * pdfjs is awkward on the server in three ways, each handled here:
 *
 * 1. ESM/worker init — we import it DYNAMICALLY (not at module top-level), so it
 *    only loads when a deterministic parser actually runs. This keeps it off the
 *    AI/generic path and isolates its initialization to parse time.
 *
 * 2. Browser globals — pdfjs references `DOMMatrix` at load time, which exists in
 *    browsers but NOT in Node on Vercel ("DOMMatrix is not defined"). We only
 *    read text positions (no rendering/canvas), so a minimal matrix is enough; we
 *    install it BEFORE importing pdfjs.
 *
 * 3. The worker file — pdfjs tries to load a separate `pdf.worker.mjs` at
 *    runtime; on Vercel that file isn't traced into the serverless bundle, so it
 *    throws "Cannot find module .../pdf.worker.mjs". Setting `disableWorker: true`
 *    alone is NOT enough on pdfjs v6 (it still resolves the worker). The fix is to
 *    import the worker module ourselves as a side-effect: that makes Next.js trace
 *    and bundle it, and registers it inline so pdfjs runs on the main thread.
 *
 * We do NOT set GlobalWorkerOptions.workerSrc (require()-resolving the worker path
 * breaks under Next.js with ESM). (Server-only — never import a parser into client
 * code.)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any;

let cached: PdfjsModule | null = null;

/**
 * Minimal DOMMatrix sufficient for pdfjs text extraction (2D affine transforms).
 * Only the operations pdfjs uses while reading text are implemented.
 */
class DOMMatrixPolyfill {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
  }

  multiplySelf(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const a = this.a * o.a + this.c * o.b;
    const b = this.b * o.a + this.d * o.b;
    const c = this.a * o.c + this.c * o.d;
    const d = this.b * o.c + this.d * o.d;
    const e = this.a * o.e + this.c * o.f + this.e;
    const f = this.b * o.e + this.d * o.f + this.f;
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    return this;
  }

  scaleSelf(sx: number, sy: number = sx): DOMMatrixPolyfill {
    this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy;
    return this;
  }

  translateSelf(tx: number, ty: number): DOMMatrixPolyfill {
    this.e += this.a * tx + this.c * ty;
    this.f += this.b * tx + this.d * ty;
    return this;
  }
}

/** Install browser-global polyfills pdfjs needs, only if they're missing. */
function ensurePdfjsGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = DOMMatrixPolyfill;
  }
}

export async function loadPdfjs(): Promise<PdfjsModule> {
  if (cached) return cached;
  ensurePdfjsGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Import the worker as a side-effect so Next.js bundles it for serverless and
  // pdfjs can run inline (combined with disableWorker:true in getDocument).
  // The worker module ships no type declarations, which is expected.
  // @ts-expect-error - no types for the worker entry point
  await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  cached = pdfjs;
  return cached;
}
