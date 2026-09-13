/**
 * Changelog page — a static list of the app's notable changes, newest first.
 * Content lives in `lib/changelog.ts`; this is just the rendering. A server
 * component (no state, no fetch). The link to it shows only in Developer view
 * (see the header in `app/page.tsx`), but the route itself is open like the rest
 * of the internal tool.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { CHANGELOG } from "@/lib/changelog"
import { strings as s } from "@/lib/strings"

export const metadata: Metadata = {
  title: "Changelog",
}

export default function ChangelogPage() {
  return (
    <main className="page subpage">
      <header className="subpage-head">
        <div>
          <h1>{s.changelogTitle}</h1>
          <p>{s.changelogSubtitle}</p>
        </div>
        <Link href="/" className="subpage-back">
          {s.backToApp}
        </Link>
      </header>

      {CHANGELOG.map((entry) => (
        <section key={entry.date} className="changelog-entry">
          <time dateTime={entry.date}>{entry.date}</time>
          <h2>{entry.title}</h2>
          <ul>
            {entry.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
