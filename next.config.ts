import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // pdfjs-dist (used by the deterministic bank parsers) is a server-only package
  // that must not be bundled — the bundler would try to bundle its worker and
  // Node built-ins and break the build/runtime. Keeping it external lets it load
  // as a normal Node ESM package. The parsers also import it lazily (see
  // pdf-loader.ts), so it never loads on the AI/generic path.
  serverExternalPackages: ["pdfjs-dist"],
}

export default nextConfig
