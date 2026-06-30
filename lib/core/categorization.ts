/**
 * Transaction categorization — two layers, AI used as little as possible.
 *
 *   Layer 1 — keyword RULES (zero AI): ordered "if the description contains X →
 *             category Y" list. Catches most transactions instantly, for free,
 *             deterministically. First matching rule wins.
 *   Layer 2 — AI (Gemini) only for the rest: descriptions no rule matched are
 *             DEDUPED (by a normalized merchant key) and sent to Gemini in PARALLEL
 *             batches, so "Tesco" is asked once even if it appears 50×. The answer is
 *             applied back to every transaction sharing that key.
 *
 * Runs AFTER reconciliation, as a separate step — it NEVER affects reconciliation
 * (categories are labels, not amounts). One fixed `category` column; the AI may only
 * choose from CATEGORIES, with "Other" as the fallback.
 *
 * The RULES/CATEGORIES are calibrated on the real descriptions in the test
 * statements (typical Irish merchants, Revolut transfers/savings/crypto, gambling).
 */

import type { Transaction } from "./types"
import { categorizeWithGemini } from "./gemini"
import { MAX_CONCURRENT_CHUNKS } from "./config"
import { DEFAULT_PRIMARY_MODEL } from "./config"

/** The fixed category list. The AI must choose ONLY from this; "Other" is the net. */
export const CATEGORIES = [
  "Income",
  "Transfers",
  "Top-up",
  "Savings",
  "Cash/ATM",
  "Groceries",
  "Dining",
  "Fuel",
  "Transport",
  "Travel",
  "Utilities",
  "Telecom",
  "Subscriptions",
  "Shopping",
  "Gambling",
  "Healthcare",
  "Insurance",
  "Rent/Premises",
  "Professional Services",
  "Taxes/Government",
  "Bank Fees",
  "Crypto",
  "Other",
] as const

type Category = (typeof CATEGORIES)[number]

// A rule matches a (lowercased) description by substring (string) or regex (when a
// word boundary matters, e.g. \bfee\b must not match "coffee"). ORDER MATTERS:
// the first matching rule wins, so specific transfer/top-up/savings patterns come
// BEFORE merchant names, and a few merchant collisions are ordered deliberately
// (e.g. "tesco mobile" → Telecom before "tesco" → Groceries).
type Rule = [string | RegExp, Category]

const RULES: Rule[] = [
  // --- Income (before Transfers: "salary transfer" should be Income) ---
  ["wages", "Income"],
  ["salary", "Income"],
  ["salari", "Income"],
  ["payroll", "Income"],
  ["invoice", "Income"],
  ["invoise", "Income"],

  // --- Crypto (before Transfers: "transfer to revolut digital assets") ---
  ["revolut digital assets", "Crypto"],
  ["digital assets europe", "Crypto"],

  // --- Savings (Revolut round-ups / savers / pockets — huge in the data) ---
  ["revpoints", "Savings"],
  ["spare change", "Savings"],
  ["mărunțiș", "Savings"],
  ["online saver", "Savings"],
  ["instant access", "Savings"],
  ["to pocket", "Savings"],
  ["from pocket", "Savings"],
  ["flexible cash", "Savings"],
  ["mobi save", "Savings"],
  [/\bsaver\b/, "Savings"],
  ["savings vault", "Savings"],

  // --- Top-up (account funding) — its own category, AFTER Savings so "savings vault
  // topup" stays Savings, and BEFORE Transfers. Real wordings: EN "top-up by" /
  // "*mobi top-up", RO "alimentare …", RU "пополнение счета …", any "… open banking". ---
  ["top-up", "Top-up"],
  ["topup", "Top-up"],
  ["alimentare", "Top-up"],
  ["пополнение", "Top-up"],
  ["open banking", "Top-up"],

  // --- Transfers / FX (internal & personal movements) ---
  ["transfer to", "Transfers"],
  ["transfer from", "Transfers"],
  ["revolut user", "Transfers"],
  ["exchanged to", "Transfers"],
  ["exchange to", "Transfers"],
  ["money added", "Transfers"],

  // --- Cash / ATM ---
  [/\batm/, "Cash/ATM"],
  ["cshm", "Cash/ATM"],
  ["cash atm", "Cash/ATM"],
  ["point cash", "Cash/ATM"],
  ["withdrawal", "Cash/ATM"],
  ["retragere numerar", "Cash/ATM"],

  // --- Bank fees ---
  [/\bfee\b/, "Bank Fees"],
  ["maintenance", "Bank Fees"],
  ["premium plan", "Bank Fees"],
  ["maintaining acc", "Bank Fees"],
  ["overdraft", "Bank Fees"],

  // --- Gambling ---
  ["superbet", "Gambling"],
  ["paddy power", "Gambling"],
  ["pokerstars", "Gambling"],
  ["bet365", "Gambling"],
  ["betano", "Gambling"],
  ["fortuna", "Gambling"],
  ["casino", "Gambling"],
  ["casa pariurilor", "Gambling"],
  ["hellcase", "Gambling"],
  ["boylesports", "Gambling"],
  ["ladbrokes", "Gambling"],
  ["pariuri", "Gambling"],
  ["lotto", "Gambling"],
  ["lottery", "Gambling"],

  // --- Telecom (before Groceries: "tesco mobile" → Telecom, not Groceries) ---
  ["vodafone", "Telecom"],
  [/\beir\b/, "Telecom"],
  [/\bthree\b/, "Telecom"],
  ["tesco mobile", "Telecom"],
  ["gomo", "Telecom"],
  ["freenet", "Telecom"],
  ["orange", "Telecom"],
  ["virgin media", "Telecom"],
  ["imobile", "Telecom"],

  // --- Subscriptions (before Shopping: "amazon prime"; specific google, not bare) ---
  ["netflix", "Subscriptions"],
  ["spotify", "Subscriptions"],
  ["youtube", "Subscriptions"],
  ["google one", "Subscriptions"],
  ["google play", "Subscriptions"],
  ["google *", "Subscriptions"],
  ["icloud", "Subscriptions"],
  ["apple com bill", "Subscriptions"],
  ["apple.com/bill", "Subscriptions"],
  ["microsoft", "Subscriptions"],
  ["openai", "Subscriptions"],
  ["chatgpt", "Subscriptions"],
  ["adobe", "Subscriptions"],
  ["amazon prime", "Subscriptions"],
  ["disney", "Subscriptions"],
  ["patreon", "Subscriptions"],
  ["linkedin", "Subscriptions"],

  // --- Travel ---
  ["ryanair", "Travel"],
  ["aer lingus", "Travel"],
  ["aerlingus", "Travel"],
  ["airbnb", "Travel"],
  ["booking.com", "Travel"],
  ["hotel", "Travel"],
  ["wizz", "Travel"],
  ["expedia", "Travel"],
  ["aircoach", "Travel"],

  // --- Transport (taxi + tolls + public transport) ---
  ["eflow", "Transport"],
  ["leap card", "Transport"],
  ["transport for ireland", "Transport"],
  [/\btfi\b/, "Transport"],
  ["luas", "Transport"],
  ["irish rail", "Transport"],
  ["dublin bus", "Transport"],
  ["bus eireann", "Transport"],
  ["toll", "Transport"],
  ["free now", "Transport"],
  ["freenow", "Transport"],
  ["bolt", "Transport"],
  [/\buber\b/, "Transport"],
  ["taxi", "Transport"],

  // --- Fuel ---
  ["circle k", "Fuel"],
  ["applegreen", "Fuel"],
  ["maxol", "Fuel"],
  ["texaco", "Fuel"],
  ["gas station", "Fuel"],
  [" msa", "Fuel"],
  ["topaz", "Fuel"],
  ["esso", "Fuel"],

  // --- Dining ---
  ["mcdonald", "Dining"],
  ["abrakebabra", "Dining"],
  ["supermac", "Dining"],
  [/\bkfc\b/, "Dining"],
  ["burger", "Dining"],
  ["subway", "Dining"],
  ["domino", "Dining"],
  ["restaur", "Dining"],
  ["catering", "Dining"],
  [/\bcafe\b/, "Dining"],
  ["coffee", "Dining"],
  ["takeaway", "Dining"],
  ["kebab", "Dining"],
  ["pizz", "Dining"],
  ["the mad hatters", "Dining"],
  ["vending", "Dining"],
  ["quick snack", "Dining"],
  ["snack", "Dining"],

  // --- Groceries ---
  ["lidl", "Groceries"],
  ["tesco", "Groceries"],
  ["spar", "Groceries"],
  ["dunnes", "Groceries"],
  ["supervalu", "Groceries"],
  ["centra", "Groceries"],
  ["aldi", "Groceries"],
  ["londis", "Groceries"],
  ["profi", "Groceries"],
  ["linella", "Groceries"],
  ["polonez", "Groceries"],
  ["moldova stores", "Groceries"],
  ["iceland", "Groceries"],

  // --- Shopping ---
  ["amazon", "Shopping"],
  ["temu", "Shopping"],
  ["shein", "Shopping"],
  ["zara", "Shopping"],
  ["penneys", "Shopping"],
  ["ikea", "Shopping"],
  ["argos", "Shopping"],
  ["aliexpress", "Shopping"],
  ["ebay", "Shopping"],
  ["asos", "Shopping"],
  ["currys", "Shopping"],
  ["smyths", "Shopping"],
  ["decathlon", "Shopping"],
  ["harvey norman", "Shopping"],

  // --- Healthcare ---
  ["boots", "Healthcare"],
  ["pharmacy", "Healthcare"],
  ["chemist", "Healthcare"],
  ["lloydspharmacy", "Healthcare"],
  ["mccabes", "Healthcare"],
  ["specsavers", "Healthcare"],
  ["hospital", "Healthcare"],
  ["clinic", "Healthcare"],
  ["dental", "Healthcare"],
  ["doctor", "Healthcare"],
  ["medical", "Healthcare"],

  // --- Insurance ---
  ["insurance", "Insurance"],
  ["allianz", "Insurance"],
  [/\baxa\b/, "Insurance"],
  ["aviva", "Insurance"],
  ["zurich", "Insurance"],
  [/\bfbd\b/, "Insurance"],
  ["liberty insura", "Insurance"],
  ["laya", "Insurance"],
  [/\bvhi\b/, "Insurance"],
  ["irish life", "Insurance"],

  // --- Utilities ---
  ["electric ireland", "Utilities"],
  [/\besb\b/, "Utilities"],
  ["bord gais", "Utilities"],
  ["pinergy", "Utilities"],
  ["energia", "Utilities"],
  ["airtricity", "Utilities"],
  ["flogas", "Utilities"],
  ["gas networks", "Utilities"],
  ["irish water", "Utilities"],
  ["panda", "Utilities"],
  ["greyhound", "Utilities"],
  ["waste", "Utilities"],

  // --- Rent / Premises ---
  [/\brent\b/, "Rent/Premises"],
  ["landlord", "Rent/Premises"],
  ["lease", "Rent/Premises"],
  ["property icav", "Rent/Premises"],

  // --- Taxes / Government ---
  ["revenue", "Taxes/Government"],
  [/\bros\b/, "Taxes/Government"],
  ["motor tax", "Taxes/Government"],
  ["stamp duty", "Taxes/Government"],
  ["customs", "Taxes/Government"],
  ["social protection", "Taxes/Government"],
  ["welfare", "Taxes/Government"],
  ["nppr", "Taxes/Government"],

  // --- Professional Services ---
  ["accountant", "Professional Services"],
  ["solicitor", "Professional Services"],
  [/\blegal\b/, "Professional Services"],
  ["consult", "Professional Services"],
  ["audit", "Professional Services"],
  ["notary", "Professional Services"],
]

/** Layer 1: the first rule whose keyword matches the description, or null. */
export function categorizeByRules(description: string): Category | null {
  const lower = (description || "").toLowerCase()
  if (!lower) return null
  for (const [matcher, category] of RULES) {
    if (typeof matcher === "string" ? lower.includes(matcher) : matcher.test(lower)) {
      return category
    }
  }
  return null
}

/**
 * A normalized "merchant key" used to DEDUPE descriptions for the AI and to apply a
 * result back to all matching rows. Lowercase, strip card masks, dates, reference
 * numbers and punctuation, collapse whitespace — so "VDC-LIDL IRELAND L 5" and
 * "vdc lidl ireland l" become the same key.
 */
export function normalizeDescription(description: string): string {
  return (description || "")
    .toLowerCase()
    .replace(/pos\d{2}[a-z]{3}/g, " ") // POS terminal date, e.g. "pos29apr"
    .replace(/\*+\d*/g, " ") // card masks / "*1234"
    .replace(/\b\d{2,}\b/g, " ") // long numbers / refs
    .replace(/[#@:,.\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Run an async fn over items with a concurrency limit, preserving order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) break
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

const AI_BATCH_SIZE = 80 // unique descriptions per Gemini call

export interface CategorizeOptions {
  useAi: boolean
  model?: string
}

export interface CategorizeStats {
  ruleCount: number // transactions categorized by rules (free)
  aiCount: number // transactions categorized via AI
  uniqueAiDescriptions: number // distinct descriptions actually sent to the AI
}

/**
 * Categorize transactions IN PLACE (sets `category` on each). Rules first; the rest
 * are deduped and (optionally) sent to Gemini in parallel batches, then the AI's
 * answer is applied to every transaction sharing the same normalized description.
 */
export async function categorizeTransactions(
  transactions: Transaction[],
  opts: CategorizeOptions,
): Promise<CategorizeStats> {
  const model = opts.model ?? DEFAULT_PRIMARY_MODEL
  let ruleCount = 0

  // Layer 1 + collect the rest, grouped by normalized key.
  const restByKey = new Map<string, Transaction[]>()
  for (const t of transactions) {
    const ruleCat = categorizeByRules(t.description)
    if (ruleCat) {
      t.category = ruleCat
      ruleCount++
      continue
    }
    const key = normalizeDescription(t.description)
    if (!key) {
      t.category = "Other"
      continue
    }
    const group = restByKey.get(key)
    if (group) group.push(t)
    else restByKey.set(key, [t])
  }

  const keys = [...restByKey.keys()]

  // Layer 2: AI on the unique remaining descriptions (in parallel batches).
  let aiMap: Record<string, string> = {}
  if (opts.useAi && keys.length > 0) {
    const batches: string[][] = []
    for (let i = 0; i < keys.length; i += AI_BATCH_SIZE)
      batches.push(keys.slice(i, i + AI_BATCH_SIZE))
    const maps = await mapWithLimit(batches, MAX_CONCURRENT_CHUNKS, (b) =>
      categorizeWithGemini(b, CATEGORIES, model),
    )
    aiMap = Object.assign({}, ...maps)
  }

  // Apply the result back to every transaction sharing the key.
  let aiCount = 0
  for (const [key, group] of restByKey) {
    const cat = aiMap[key] ?? "Other"
    for (const t of group) t.category = cat
    if (opts.useAi) aiCount += group.length
  }

  return { ruleCount, aiCount, uniqueAiDescriptions: keys.length }
}
