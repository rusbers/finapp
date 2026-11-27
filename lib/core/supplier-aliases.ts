/**
 * Supplier aliases for expense matching — DEVELOPER-MAINTAINED, extended on demand.
 *
 * Some suppliers appear on the bank line under a completely different name from the one
 * on the receipt (legal vs trading name, an acronym, a parent brand), so no fuzzy text
 * rule can link them: "CSS LTD" ↔ "VDP-CITYSAWSERVICE". An alias tells `matchExpenses`
 * (lib/core/expenses.ts) that they are the same supplier. The amount (exact cents) and
 * the date window still apply — an alias only replaces the NAME check.
 *
 * How to add one:
 *   - `supplier`: the name as it appears on the receipt / in expenses.csv. Matched fuzzily
 *     (same rules as the normal name check), so "Applus" covers
 *     "Applus+ Car Testing Service" and "Applus Inspection Services Ireland".
 *   - `bank`: one or more names EXACTLY as the bank line shows them — whole words, in order,
 *     truncation included ("JOHNSTONES DEC", not "Johnstones Decorating"). Prefixes like
 *     "VDC-" / "POS" are separate words and can be left out. Spacing/punctuation don't matter.
 *     Matched strictly (the whole phrase as adjacent words), so "AIC PAINTS" never matches
 *     "PAT MCDONNELL PAINTS".
 *   - `note`: where the pair was seen / why it's right — so the next person can trust it.
 * Only add pairs confirmed on real data (same amount, a few days apart); then run
 * `npm run test:expenses`.
 *
 * Pure data, no imports — this module is bundled into both the server route and the browser.
 */

export interface SupplierAlias {
  supplier: string
  bank: string[]
  note?: string
}

export const SUPPLIER_ALIASES: SupplierAlias[] = [
  {
    supplier: "CSS LTD",
    bank: ["CITYSAWSERVICE"],
    note: "City Saw Service. Client 4: €900.66, same day.",
  },
  {
    supplier: "Allied Industrial Coatings",
    bank: ["AIC PAINTS"],
    note: "AIC = Allied Industrial Coatings. Client 1: €1494.45, +3 days.",
  },
  {
    supplier: "PPG Architectural Coatings",
    bank: ["JOHNSTONES DEC"],
    note: "Johnstone's Decorating Centres is a PPG brand. Client 1: €27.40, +1 day.",
  },
  {
    supplier: "Applus",
    bank: ["NCTS"],
    note: "Applus+ runs the NCT (car test); bank shows WWW NCTS IE. Clients 2 and 3: three payments, +1/+2 days.",
  },
  {
    supplier: "AXA",
    bank: ["AXA INSURANCE"],
    note: "Branch name on the receipt (AXA Long Mile Road). Client 4: €49.54, +1 day.",
  },
]
