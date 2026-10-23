/**
 * money.js — Single Source of Truth for Money Conversions
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE: All money conversion between cents (DB) and decimal (UI) MUST go
 *       through this module. No manual `/ 100` or `* 100` anywhere else.
 *
 * DB stores integers (cents):   150050  = 1500.50 جنيه
 * UI displays decimals:         1500.50 = 1500.50 جنيه
 *
 * This module provides:
 *   Money.toCents(decimal)       → integer   (UI → DB)
 *   Money.toDecimal(cents)       → number    (DB → UI)
 *   Money.round(decimal)         → number    (safe 2-decimal rounding)
 *   Money.fmt(decimal)           → string    (display formatting "1,500.50")
 *   Money.fmtCents(cents)        → string    (DB value → display string)
 *   Money.decimalizeRecord(rec)  → record    (convert all money fields in a DB record)
 *   Money.FIELDS                 → string[]  (list of money field names)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── CORE CONVERSIONS ──────────────────────────────────────────────────────────

/**
 * Convert a decimal amount (UI) to integer cents (DB).
 *
 *   toCents(1500.50) → 150050
 *   toCents(0.1 + 0.2) → 30   (not 30.000000000000004)
 *   toCents(0) → 0
 *   toCents(null) → 0
 *   toCents("1500.50") → 150050
 */
function toCents(decimal) {
  return Math.round((Number(decimal) || 0) * 100);
}

/**
 * Convert integer cents (DB) back to a decimal amount (UI).
 *
 *   toDecimal(150050) → 1500.50
 *   toDecimal(30) → 0.30
 *   toDecimal(0) → 0
 *   toDecimal(null) → 0
 */
function toDecimal(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

/**
 * Safe 2-decimal rounding for decimal amounts.
 * Use when doing arithmetic on decimal values (not cents).
 *
 *   round(1500.505) → 1500.51
 *   round(0.1 + 0.2) → 0.30
 */
function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─── FORMATTING ────────────────────────────────────────────────────────────────

/**
 * Format a decimal amount for display.
 *
 *   fmt(1500.5)  → "1500.50"
 *   fmt(0)       → "0.00"
 *   fmt(null)    → "0.00"
 *   fmt(-1500.5) → "-1500.50"
 */
function fmt(decimal) {
  return (Number(decimal) || 0).toFixed(2);
}

/**
 * Format a cents value (from DB) directly to display string.
 * Shortcut for: fmt(toDecimal(cents))
 *
 *   fmtCents(150050) → "1500.50"
 *   fmtCents(0)      → "0.00"
 */
function fmtCents(cents) {
  return fmt(toDecimal(cents));
}

// ─── RECORD DECIMALIZATION ─────────────────────────────────────────────────────

/**
 * All money field names used across the system.
 * When reading a record from DB, these fields contain cents.
 * decimalizeRecord() converts them all to decimals for UI consumption.
 */
const FIELDS = Object.freeze([
  'amount',
  'total',
  'paid',
  'remaining',
  'balance',
  'subtotal',
  'deposit_total',
  'withdraw_total',
  'general_add',
  'general_discount',
  'net_due',
  'previous_balance',
  'net_total',
]);

/**
 * Convert all money fields in a DB record from cents to decimals.
 * Non-money fields are passed through unchanged.
 * Returns a new object (does not mutate the original).
 *
 *   decimalizeRecord({ total: 150050, rows: [...] })
 *   → { total: 1500.50, rows: [...] }
 */
function decimalizeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const field of FIELDS) {
    if (field in out) out[field] = toDecimal(out[field]);
  }
  return out;
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

const Money = Object.freeze({
  toCents,
  toDecimal,
  round,
  fmt,
  fmtCents,
  decimalizeRecord,
  FIELDS,
});

export { Money };
export default Money;
