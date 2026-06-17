/**
 * Lazy loader for pdfjs-dist, with a minimal DOMMatrix polyfill.
 *
 * Two things make pdfjs awkward on the server:
 *
 * 1. ESM/worker quirks — so we import it DYNAMICALLY (not at module top-level),
 *    so it only loads when a deterministic parser actually runs. This keeps it
 *    off the AI/generic path and isolates its initialization to parse time.
 *
 * 2. Browser globals — pdfjs references `DOMMatrix` (and friends) at load time.
 *    These exist in browsers but NOT in the Node.js runtime on serverless
 *    (Vercel), which throws "DOMMatrix is not defined". Since we only read text
 *    positions (no rendering/canvas), a minimal matrix implementation is enough.
 *    We install the polyfill BEFORE importing pdfjs.
 *
 * We intentionally do NOT set GlobalWorkerOptions.workerSrc: pdfjs-dist v6 is
 * ESM, so require()-resolving the worker path breaks under Next.js. Leaving it
 * unset uses pdfjs's built-in main-thread fallback. (Server-only.)
 *
 * The module is cached after the first load so repeated calls are cheap.
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
  cached = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return cached;
}
