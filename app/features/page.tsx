/**
 * Features page — what a user can do in the app, grouped by task.
 * Content lives in `lib/features.ts` (update it whenever a feature ships); this is
 * just the rendering. A server component (no state, no fetch), linked from the
 * header in Developer view for now (it will go public later; /changelog stays dev-only).
 */

import type { Metadata } from "next"
import Link from "next/link"
import { FEATURE_GROUPS } from "@/lib/features"
import { strings as s } from "@/lib/strings"

export const metadata: Metadata = {
  title: "Features",
}

export default function FeaturesPage() {
  return (
    <main className="page subpage">
      <header className="subpage-head">
        <div>
          <h1>{s.featuresTitle}</h1>
          <p>{s.featuresSubtitle}</p>
        </div>
        <Link href="/" className="subpage-back">
          {s.backToApp}
        </Link>
      </header>

      {FEATURE_GROUPS.map((group) => (
        <section key={group.title} className="feature-group">
          <h2>{group.title}</h2>
          {group.intro && <p className="feature-intro">{group.intro}</p>}
          <dl>
            {group.features.map((f) => (
              <div key={f.name} className="feature">
                <dt>{f.name}</dt>
                <dd>{f.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </main>
  )
}
