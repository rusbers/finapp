/**
 * Shared by app/layout.tsx (server) and app/theme-switch.tsx (client).
 * Kept out of the "use client" file so the server layout can read the values.
 */

export type ThemeChoice = "system" | "light" | "dark"

/** localStorage key; absent = follow the device. */
export const THEME_KEY = "theme"

/** Inlined in <head>: applies a saved forced theme before first paint (no flash). */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`
