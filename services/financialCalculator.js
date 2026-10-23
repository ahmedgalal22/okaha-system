/**
 * financialCalculator.js — Shared Financial Calculation Layer
 * Ensures absolute consistency of money math between UI, local IndexedDB, and future MySQL databases.
 */

import { Money } from '../money.js';

/**
 * Calculates the net value of a single data row.
 * Formula: ((weight + weight2) - deficit) * noloon - (ohda + officeAmount + discount) + add
 */
export function calculateRowNet(row) {
  if (!row) return 0;
  if (row._type === 'separator' || row.type === 'separator' || row.row_type === 'separator') return 0;

  const weight       = Number(row.weight)       || 0;
  const weight2      = Number(row.weight2)      || 0;
  const deficit      = Number(row.deficit)      || 0;
  const noloon       = Number(row.noloon)       || 0;
  const ohda         = Number(row.ohda)         || 0;
  const officeAmount = Number(row.officeAmount ?? row.office_amount ?? row.officeAmount) || 0;
  const discount     = Number(row.discount)     || 0;
  const add          = Number(row.add)          || 0;
  const army         = Number(row.army)         || 0;

  const net = ((weight + weight2) - deficit) * noloon
            - (ohda + officeAmount + discount)
            + add
            + army;

  return Money.round(net);
}

/**
 * Calculates totals for a full receipt based on its rows.
 * Returns: { total, net_due, net_total, balance }
 */
export function calculateReceiptTotals(rows, general_add = 0, previous_balance = 0, paid = 0) {
  const dataRows = (rows || []).filter(r => r && r._type !== 'separator' && r.type !== 'separator' && r.row_type !== 'separator');
  
  let totalCents = 0;
  for (const r of dataRows) {
    totalCents += Money.toCents(calculateRowNet(r));
  }
  const total = Money.toDecimal(totalCents);

  const genAddCents = Money.toCents(general_add);
  const prevBalCents = Money.toCents(previous_balance);
  const paidCents = Money.toCents(paid);

  const net_due = Money.toDecimal(totalCents + genAddCents);
  const net_total = Money.toDecimal(totalCents + genAddCents + prevBalCents);
  const balance = Money.toDecimal(totalCents + genAddCents + prevBalCents - paidCents);

  return {
    total,
    net_due,
    net_total,
    balance
  };
}

/**
 * Calculates aggregate totals for Treasury entries.
 */
export function calculateTreasuryTotals(entries) {
  let total_in = 0;
  let total_payout = 0;
  let total_salfa = 0;
  let total_expense = 0;
  let total_mandoub = 0;
  let total_bolsa = 0;

  for (const e of (entries || [])) {
    if (!e) continue;
    const amt = Number(e.amount) || 0; // already in cents
    if (e.type === 'deposit') {
      total_in += amt;
    }
    if (e.effect === 'receipt_payout') total_payout += amt;
    if (e.effect === 'salfa') total_salfa += amt;
    if (e.effect === 'expense' || e.effect === 'salary') total_expense += amt;
    if (e.effect === 'mandoub_cash_out') total_mandoub += amt;
    if (e.effect === 'bolsa_deduction') total_bolsa += amt;
  }

  return {
    total_in: Money.toDecimal(total_in),
    total_payout: Money.toDecimal(total_payout),
    total_salfa: Money.toDecimal(total_salfa),
    total_expense: Money.toDecimal(total_expense),
    total_mandoub: Money.toDecimal(total_mandoub),
    total_bolsa: Money.toDecimal(total_bolsa),
  };
}
