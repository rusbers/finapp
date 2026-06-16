/**
 * Bank-specific extraction prompts.
 *
 * Structure:
 *   - BASE_PROMPT: generic rules that apply to ANY statement.
 *   - BANK_RULES: extra, bank-specific guidance appended to the base prompt for
 *     known banks (Revolut, AIB, BOI, PTSB...).
 *   - getPrompt(bank): returns the base prompt plus any bank-specific rules.
 *
 * To add a new bank: add one entry to BANK_RULES. Nothing else changes.
 *
 * Note: today the bank is chosen explicitly (UI dropdown / API field). Later,
 * automatic bank identification can select it instead — this registry stays the
 * same.
 */

/** Bank identifiers we have specialized handling for. "generic" = no specialization. */
export type BankId = "generic" | "revolut" | "aib" | "boi" | "ptsb";

export const BANK_LABELS: Record<BankId, string> = {
  generic: "Auto / Generic",
  revolut: "Revolut",
  aib: "AIB",
  boi: "Bank of Ireland",
  ptsb: "Permanent TSB",
};

const BASE_PROMPT = `You are a bank statement data extraction system.
This PDF may be an EXCERPT (a few pages) of a larger bank statement.
Analyze it and return STRICTLY a single JSON object, with no text before or
after, no explanations.

Exact structure:
{
  "bank": "bank name",
  "openingBalance": number or null,
  "closingBalance": number or null,
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "text", "debit": number, "credit": number, "balance": number or null }
  ]
}

RULES:
- "debit" = money OUT of the account (payments, withdrawals). Positive number.
- "credit" = money INTO the account (deposits, incoming). Positive number.
- If a transaction is debit only, set credit = 0. If credit only, set debit = 0.
- "balance" = the running balance shown for that row. If the statement shows no
  running balance column, set balance = null. Do NOT compute it yourself; only
  copy the value printed on the statement.
- Write all numbers as plain JSON numbers: a dot decimal separator and NO
  thousands separators (write 1000.00, never 1,000.00).
- Dates in YYYY-MM-DD format.
- "openingBalance" = the opening/brought-forward balance ONLY if it appears on
  these pages (usually only on the first page of the full statement). If these
  pages do not show it, set openingBalance = null. Do NOT guess it.
- "closingBalance" = the closing/carried-forward balance ONLY if it appears on
  these pages (usually only on the last page). If not shown here, set it to null.
- CRITICAL: list the transactions in the EXACT SAME ORDER they appear on these
  pages, top to bottom. Do NOT sort or reorder them (not by date, not
  alphabetically, not by amount). Preserve the original order exactly.
- Include ALL transactions on these pages.`;

/** Bank-specific rules appended after the base prompt. */
const BANK_RULES: Partial<Record<BankId, string>> = {
  revolut: `
THIS IS A REVOLUT STATEMENT. Apply these Revolut-specific rules:
- Columns are: "Sume retrase" / "Money out" = debit; "Sume adaugate" /
  "Money in" = credit; "Sold" / "Balance" = balance.
- A transaction's sub-text may include a reference, a "De la:"/"Catre:" (From/To)
  line, and a "Comision:"/"Fee:" line. ALL of this is part of the description.
- IMPORTANT: the "Comision:"/"Fee:" shown in the sub-text is INFORMATIONAL ONLY.
  It is NOT a separate transaction and it is already reflected in the balance.
  Do NOT create an extra transaction for the fee, and do NOT add or subtract it
  from the amount. Use ONLY the value in the money-out/money-in column as the
  transaction amount.
- FOREIGN-CURRENCY (FX) transactions: a row may show extra sub-text such as
  "Cursul Revolut EUR1.00 = 19.22 MDL", "Cursul ECB ...", an MDL amount, or a
  second euro figure. ALL of these are INFORMATIONAL. The real transaction amount
  is ALWAYS the single value in the "Sume retrase"/"Sume adaugate" (money-out/
  money-in) column — this already includes any fee. Do NOT use the exchange rate,
  the MDL amount, or the fee as the amount. Never put two numbers in one
  transaction. The description may contain these texts, but the numeric debit/
  credit must be ONLY the money-out/money-in column value.
- Each row changes the balance exactly once. One row = one transaction.
- CRITICAL: extract ONLY the transactions from the MAIN account table — the one
  that HAS a "Sold"/"Balance" column. Revolut statements may include extra
  informational sections AFTER the main table (for example "Inapoiate"/"Reverted",
  "Early credit grant", pending or reverted lists). These extra sections do NOT
  have a Balance column. They are NOT part of the account flow — IGNORE them
  completely and do NOT include their rows as transactions. If a row has no
  Balance column, it belongs to an informational section and must be skipped.`,
};

/** Returns the full prompt for a bank: base rules plus any bank-specific rules. */
export function getPrompt(bank: BankId): string {
  const extra = BANK_RULES[bank];
  return extra ? `${BASE_PROMPT}\n${extra}` : BASE_PROMPT;
}
