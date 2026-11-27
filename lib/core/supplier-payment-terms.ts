/**
 * Late-paying suppliers for expense matching — DEVELOPER-MAINTAINED, extended on demand.
 *
 * Normally a bank debit must fall within ±DEFAULT_WINDOW_DAYS of the receipt date
 * (lib/core/expenses.ts). Some suppliers invoice first and are paid much later — eFlow toll
 * invoices are dated the 1st and charged ~16–18 days after. An entry here lets the bank
 * posting come up to `maxDaysAfter` days AFTER the receipt for that supplier. Only the
 * AFTER side widens: these amounts often repeat every month (eFlow €16.53), so looking
 * further back would grab the previous month's charge.
 *
 * Every match that needed the longer delay is flagged TBC ("late-payment supplier"), so
 * the accountant still reviews it. The amount (exact cents) and the supplier name rules
 * are unchanged.
 *
 * How to add one:
 *   - `supplier`: the name as it appears on the receipt / in expenses.csv. Matched fuzzily
 *     (same rules as the normal name check), so "eFlow" covers "eFlow", "Eflow", "eFlow Ltd".
 *   - `maxDaysAfter`: the longest usual delay between the invoice date and the bank charge,
 *     with a little margin — keep it shorter than the billing cycle (eFlow is monthly → 25).
 *   - `note`: where the delay was seen — so the next person can trust it.
 * Then run `npm run test:expenses`.
 *
 * Pure data, no imports — this module is bundled into both the server route and the browser.
 */

export interface PaymentTerm {
  supplier: string
  maxDaysAfter: number
  note?: string
}

export const SUPPLIER_PAYMENT_TERMS: PaymentTerm[] = [
  {
    supplier: "eFlow",
    maxDaysAfter: 25,
    note: "Toll invoices dated the 1st, charged 16–18 days later (VDP-EFLOW BARRIER). Client 4.",
  },
]
