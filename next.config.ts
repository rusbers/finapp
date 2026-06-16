import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // pdfjs-dist (used by the deterministic bank parsers) is a server-only package.
  // Keeping it external prevents the bundler from trying to bundle its worker and
  // Node built-ins, which would break the build.
  serverExternalPackages: ["pdfjs-dist"],
}

export default nextConfig
