"use client"

import { useSyncExternalStore } from "react"
import { strings as s } from "@/lib/strings"
import { THEME_KEY, type ThemeChoice } from "@/lib/theme"

/* ------------------------------------------------------------------ *
 * Appearance switch: Match device / Light / Dark.
 *
 * The choice is stored in localStorage under THEME_KEY and applied as
 * <html data-theme="light|dark"> (no attribute = follow the device). The
 * colours themselves are light-dark() pairs in globals.css.
 *
 * The saved choice is applied before first paint by THEME_INIT_SCRIPT
 * (lib/theme.ts), which app/layout.tsx inlines in <head>, so a forced theme never flashes.
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>()

function readChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === "light" || t === "dark") return t
  } catch {
    // storage blocked → follow the device
  }
  return "system"
}

function subscribe(callback: () => void): () => void {
  // Another tab changed the choice → apply it here too, then re-render.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_KEY) return
    applyChoice(readChoice())
    callback()
  }
  listeners.add(callback)
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener("storage", onStorage)
  }
}

function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === "system") delete root.dataset.theme
  else root.dataset.theme = choice
}

function setChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
  } catch {
    // ignore write failures — the choice still applies to this page
  }
  applyChoice(choice)
  listeners.forEach((l) => l())
}

const ICONS: Record<ThemeChoice, React.ReactNode> = {
  // Half-filled circle: "whatever the device says"
  system: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  light: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M3.05 12.95l1.13-1.13M11.82 4.18l1.13-1.13" />
    </>
  ),
  dark: <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" />,
}

const ORDER: ThemeChoice[] = ["system", "light", "dark"]

export function ThemeSwitch() {
  // Server snapshot is "system", so SSR markup matches the default and the
  // client corrects itself after hydration without a mismatch warning.
  const choice = useSyncExternalStore(subscribe, readChoice, () => "system" as ThemeChoice)

  return (
    <div className="theme-switch" role="radiogroup" aria-label={s.theme.label}>
      {ORDER.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={choice === c}
          aria-label={s.theme[c]}
          title={s.theme[c]}
          className={choice === c ? "on" : ""}
          onClick={() => setChoice(c)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {ICONS[c]}
          </svg>
        </button>
      ))}
    </div>
  )
}
