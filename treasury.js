/**
 * treasury.js — صفحة الخزنة
 * Internal structure: Constants → Services → Rendering → Events → Public API
 *
 * Treasury entries (effect column — MySQL ENUM):
 *   capital_deposit   ← إيداع رأس مال
 *   receipt_payout    ← صرف كارتة (تلقائي من updateReceiptStatus)
 *   salfa             ← سلفة لعميل/وسيط/شخص آخر
 *   expense           ← مصروف
 *   salary            ← مرتب
 *   bolsa_deduction   ← خصم بوالص من مندوب (من createBolsaForm)
 *   mandoub_cash_out  ← إيداع فلوس للمندوب (من adjustMandoubBalance)
 *   mandoub_cash_in   ← استلام فلوس من المندوب (من adjustMandoubBalance)
 */

import { DB } from './database.js';
import { Money } from './money.js';
import { FinancialService } from './financial.js';
import { AuthModule } from './auth.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { DBProvider } from './services/dbProvider.js';
import { TreasuryRepository } from './services/treasuryRepository.js';
import { ClientRepository } from './services/clientRepository.js';
import { calculateTreasuryTotals } from './services/financialCalculator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const STORE = Object.freeze({
  TREASURY: 'treasury',
  LEDGER  : 'vehicle_ledger',
});

const EFFECTS = Object.freeze({
  CAPITAL_DEPOSIT  : 'capital_deposit',
  RECEIPT_PAYOUT   : 'receipt_payout',
  SALFA            : 'salfa',
  EXPENSE          : 'expense',
  SALARY           : 'salary',
  BOLSA_DEDUCTION  : 'bolsa_deduction',
  MANDOUB_CASH_OUT : 'mandoub_cash_out',
  MANDOUB_CASH_IN  : 'mandoub_cash_in',
});

// Effects that appear in "صرف كارتات وسلفيات" tab
const PAYOUT_EFFECTS = Object.freeze([
  EFFECTS.RECEIPT_PAYOUT,
  EFFECTS.SALFA,
]);

// Effects that appear in "مصروفات ومرتبات" tab
const EXPENSE_EFFECTS = Object.freeze([
  EFFECTS.EXPENSE,
  EFFECTS.SALARY,
]);

function _uuid() {
  return crypto.randomUUID();
}

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) throw new Error('Username required');
  return session.username;
}

function _todayISO() {
  return new Date().toISOString().split('T')[0];
}

function _nowISO() {
  return new Date().toISOString();
}

function _effectLabel(effect) {
  switch (effect) {
    case EFFECTS.CAPITAL_DEPOSIT:  return 'إيداع رأس مال';
    case EFFECTS.RECEIPT_PAYOUT:   return 'صرف كارتة';
    case EFFECTS.SALFA:            return 'سلفة';
    case EFFECTS.EXPENSE:          return 'مصروف';
    case EFFECTS.SALARY:           return 'مرتب';
    case EFFECTS.BOLSA_DEDUCTION:  return 'خصم بوالص';
    case EFFECTS.MANDOUB_CASH_OUT: return 'إيداع للمندوب';
    case EFFECTS.MANDOUB_CASH_IN:  return 'استلام من المندوب';
    default: return effect || '—';
  }
}

function _typeIcon(type) {
  return type === 'deposit' ? '⬇️' : '⬆️';
}

function _directionClass(type) {
  return type === 'deposit' ? 'treasury-in' : 'treasury-out';
}

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _dateDisplay(v) {
  if (!v) return '—';
  return String(v).split('T')[0];
}

function _timeDisplay(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TreasuryService — Financial Operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deposit capital into the treasury (إيداع رأس مال)
 */
async function depositCapital(username, { amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();

  const [entry] = await DBProvider.transaction([{
    op: 'add',
    store: STORE.TREASURY,
    payload: {
      username,
      type: 'deposit',
      effect: EFFECTS.CAPITAL_DEPOSIT,
      amount: cents,
      account_type: 'cash',
      reference_type: 'capital',
      reference_id: _uuid(),
      client_id: null,
      client_type: null,
      client_name: null,
      date: isoDate,
      applied_at: _nowISO(),
      is_reversed: false,
      note: String(note || '').trim() || 'إيداع رأس مال',
    },
  }], { username });

  window.dispatchEvent(new CustomEvent('treasury:changed'));
  return Money.decimalizeRecord(entry);
}

/**
 * Create a salfa (سلفة) — partial advance payment to a client
 */
async function createSalfa(username, { client_id, client_type, client_name, amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();
  const refId = _uuid();
  const now = _nowISO();
  const noteText = String(note || '').trim() || 'سلفة';

  const ops = [
    // Treasury: cash out
    {
      op: 'add',
      store: STORE.TREASURY,
      payload: {
        username,
        type: 'withdraw',
        effect: EFFECTS.SALFA,
        amount: cents,
        account_type: 'cash',
        reference_type: 'salfa',
        reference_id: refId,
        client_id: client_id || null,
        client_type: client_type || null,
        client_name: client_name || null,
        date: isoDate,
        applied_at: now,
        is_reversed: false,
        note: noteText,
      },
    },
  ];

  // Entity ledger: withdraw from client balance (only if registered client)
  if (client_id && client_type === 'owner') {
    ops.push({
      op: 'add',
      store: STORE.LEDGER,
      payload: {
        username,
        owner_id: String(client_id),
        owner_name: client_name || null,
        client_id: String(client_id),
        client_type: client_type,
        client_name: client_name || null,
        vehicle_id: null,
        vehicle_plate: null,
        type: 'withdraw',
        amount: cents,
        reference_type: 'salfa',
        reference_id: refId,
        date: isoDate,
        applied_at: now,
        is_reversed: false,
        note: `سلفة — ${noteText}`,
      },
    });
  }

  const results = await DBProvider.transaction(ops, { username });

  // Auto-update unpaid receipts for this client
  if (client_id && client_type === 'owner') {
    await FinancialService.updateClientUnpaidBalances(client_id, username);
  }

  window.dispatchEvent(new CustomEvent('treasury:changed'));
  return Money.decimalizeRecord(results[0]);
}

/**
 * Create an expense or salary (مصروف أو مرتب)
 */
async function createExpense(username, { subtype, description, employee_name, amount, date, note }) {
  if (!username) throw new Error('[Treasury] username required');
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = date || _todayISO();
  const isSalary = subtype === 'salary';
  const effect = isSalary ? EFFECTS.SALARY : EFFECTS.EXPENSE;
  const desc = isSalary
    ? `مرتب: ${String(employee_name || '').trim()}`
    : String(description || '').trim() || 'مصروف';

  const [entry] = await DBProvider.transaction([{
    op: 'add',
    store: STORE.TREASURY,
    payload: {
      username,
      type: 'withdraw',
      effect,
      amount: cents,
      account_type: 'cash',
      reference_type: effect,
      reference_id: _uuid(),
      client_id: null,
      client_type: null,
      client_name: isSalary ? String(employee_name || '').trim() : null,
      employee_name: isSalary ? String(employee_name || '').trim() : null,
      description: desc,
      date: isoDate,
      applied_at: _nowISO(),
      is_reversed: false,
      note: String(note || '').trim() || desc,
    },
  }], { username });

  window.dispatchEvent(new CustomEvent('treasury:changed'));
  return Money.decimalizeRecord(entry);
}

/**
 * Edit a treasury entry (تعديل حركة)
 */
async function editEntry(username, entryId, patch) {
  if (!username) throw new Error('[Treasury] username required');
  if (!entryId) throw new Error('[Treasury] entryId required');

  const existing = await TreasuryRepository.getById(entryId);
  if (!existing) throw new Error('❌ الحركة غير موجودة');
  if (existing.username !== username) throw new Error('❌ غير مسموح');

  // Only allow editing manual entries — not auto entries
  const editableEffects = [EFFECTS.CAPITAL_DEPOSIT, EFFECTS.SALFA, EFFECTS.EXPENSE, EFFECTS.SALARY];
  if (!editableEffects.includes(existing.effect)) {
    throw new Error('❌ لا يمكن تعديل هذه الحركة — هي حركة تلقائية');
  }

  const updates = {};
  if (patch.amount !== undefined) updates.amount = Money.toCents(patch.amount);
  if (patch.date !== undefined) updates.date = patch.date;
  if (patch.note !== undefined) updates.note = String(patch.note || '').trim() || null;
  if (patch.description !== undefined) updates.description = String(patch.description || '').trim() || null;
  if (patch.client_name !== undefined) updates.client_name = String(patch.client_name || '').trim() || null;
  if (patch.employee_name !== undefined) updates.employee_name = String(patch.employee_name || '').trim() || null;

  const updated = await TreasuryRepository.update(entryId, updates, { username });
  window.dispatchEvent(new CustomEvent('treasury:changed'));
  return Money.decimalizeRecord(updated);
}

/**
 * Delete (reverse) a treasury entry (حذف / عكس حركة)
 */
async function deleteEntry(username, entryId) {
  if (!username) throw new Error('[Treasury] username required');
  if (!entryId) throw new Error('[Treasury] entryId required');

  const existing = await TreasuryRepository.getById(entryId);
  if (!existing) throw new Error('❌ الحركة غير موجودة');
  if (existing.username !== username) throw new Error('❌ غير مسموح');

  const editableEffects = [EFFECTS.CAPITAL_DEPOSIT, EFFECTS.SALFA, EFFECTS.EXPENSE, EFFECTS.SALARY];
  if (!editableEffects.includes(existing.effect)) {
    throw new Error('❌ لا يمكن حذف هذه الحركة — هي حركة تلقائية');
  }

  const now = _nowISO();
  const ops = [
    {
      op: 'update',
      store: STORE.TREASURY,
      id: entryId,
      patch: { is_reversed: true, reversed_at: now, reversed_by: username },
    },
  ];

  // If this was a salfa with a ledger entry, reverse that too
  if (existing.effect === EFFECTS.SALFA && existing.reference_id && existing.client_id) {
    const ledgerEntries = await DBProvider.getByIndex(STORE.LEDGER, 'by_reference_id', existing.reference_id);
    for (const le of ledgerEntries) {
      if (le.is_reversed === true) continue;
      if (le.reference_type !== 'salfa') continue;
      ops.push({
        op: 'update',
        store: STORE.LEDGER,
        id: le.id,
        patch: { is_reversed: true, reversed_at: now, reversed_by: username },
      });
    }
  }

  await DBProvider.transaction(ops, { username });
  window.dispatchEvent(new CustomEvent('treasury:changed'));
}

/**
 * Get treasury summary (إجماليات الخزنة)
 */
async function getSummary(username, filters = null) {
  if (!username) throw new Error('[Treasury] username required');

  const all = await TreasuryRepository.getAll(username);
  let entries = all.filter(e => e.is_reversed === false);

  // Date filter
  if (filters?.from || filters?.to) {
    entries = entries.filter(e => {
      const d = String(e.date || '').split('T')[0];
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
      return true;
    });
  }

  let total_in = 0;
  let total_payout = 0;
  let total_salfa = 0;
  let total_expense = 0;
  let total_mandoub = 0;
  let total_bolsa = 0;

  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'deposit') {
      total_in += amt;
    }
    if (e.effect === EFFECTS.RECEIPT_PAYOUT) total_payout += amt;
    if (e.effect === EFFECTS.SALFA) total_salfa += amt;
    if (e.effect === EFFECTS.EXPENSE || e.effect === EFFECTS.SALARY) total_expense += amt;
    if (e.effect === EFFECTS.MANDOUB_CASH_OUT) total_mandoub += amt;
    if (e.effect === EFFECTS.BOLSA_DEDUCTION) total_bolsa += amt;
  }

  // Full balance (no date filter — always from start)
  const allActive = all.filter(e => e.is_reversed === false);
  let balance_in = 0;
  let balance_out = 0;
  for (const e of allActive) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'deposit') balance_in += amt;
    if (e.type === 'withdraw') balance_out += amt;
  }

  return {
    balance: Money.toDecimal(balance_in - balance_out),
    total_in: Money.toDecimal(total_in),
    total_payout: Money.toDecimal(total_payout),
    total_salfa: Money.toDecimal(total_salfa),
    total_expense: Money.toDecimal(total_expense),
    total_mandoub: Money.toDecimal(total_mandoub),
    total_bolsa: Money.toDecimal(total_bolsa),
  };
}

/**
 * Get filtered entries for display
 */
async function getEntries(username, filters = null) {
  if (!username) throw new Error('[Treasury] username required');

  const all = await TreasuryRepository.getAll(username);
  let entries = all.filter(e => e.is_reversed === false);

  if (filters?.from || filters?.to) {
    entries = entries.filter(e => {
      const d = String(e.date || '').split('T')[0];
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
      return true;
    });
  }

  if (filters?.tab === 'payouts') {
    entries = entries.filter(e => PAYOUT_EFFECTS.includes(e.effect));
  } else if (filters?.tab === 'expenses') {
    entries = entries.filter(e => EXPENSE_EFFECTS.includes(e.effect));
  }

  return entries
    .sort((a, b) => {
      const da = new Date(b.applied_at || b.date || 0).getTime();
      const db = new Date(a.applied_at || a.date || 0).getTime();
      return da - db;
    })
    .map(Money.decimalizeRecord);
}

const TreasuryService = Object.freeze({
  depositCapital,
  createSalfa,
  createExpense,
  editEntry,
  deleteEntry,
  getSummary,
  getEntries,
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI State
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
  tab: 'all',
  from: '',
  to: '',
  editingId: null,
  search: { all: '', payouts: '', expenses: '' },
};

function _setQuickRange(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  STATE.from = from.toISOString().slice(0, 10);
  STATE.to = to.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════════

function _renderShell() {
  const page = document.getElementById('treasuryPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">
      <div class="card-header mb-4">
        <h2 class="card-title mb-0">الخزنة</h2>
      </div>

      <!-- Summary Cards -->
      <div id="treasurySummaryCards" class="flex flex-nowrap gap-2 pb-2 mb-6 overflow-x-auto"></div>

      <!-- Action Buttons -->
      <div class="flex flex-wrap gap-2 mb-6">
        <button type="button" data-action="treasury-deposit" class="btn btn-success btn-sm">➕ إيداع رأس مال</button>
        <button type="button" data-action="treasury-salfa" class="btn btn-primary btn-sm">💰 سلفة</button>
        <button type="button" data-action="treasury-expense" class="btn btn-secondary btn-sm">📦 مصروف / مرتب</button>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-3 items-end mb-4">
        <button type="button" data-action="treasury-range" data-days="1" class="btn btn-secondary btn-sm">اليوم</button>
        <button type="button" data-action="treasury-range" data-days="7" class="btn btn-secondary btn-sm">أسبوع</button>
        <button type="button" data-action="treasury-range" data-days="30" class="btn btn-secondary btn-sm">شهر</button>
        <div class="form-group mb-0">
          <label class="label mb-1 text-xs" for="treasuryFrom">من</label>
          <input id="treasuryFrom" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1 text-xs" for="treasuryTo">إلى</label>
          <input id="treasuryTo" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="treasury-apply-filter" class="btn btn-primary btn-sm">تطبيق</button>
        <button type="button" data-action="treasury-clear-filter" class="btn btn-secondary btn-sm">مسح</button>
      </div>

      <!-- Tabs -->
      <div class="tabs mb-4" role="tablist">
        <button type="button" data-action="treasury-tab" data-tab="all" class="tab-btn active-purple">📊 الكل</button>
        <button type="button" data-action="treasury-tab" data-tab="payouts" class="tab-btn">📋 صرف كارتات وسلفيات</button>
        <button type="button" data-action="treasury-tab" data-tab="expenses" class="tab-btn">📦 مصروفات ومرتبات</button>
      </div>

      <!-- Search + Print -->
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
        <input id="treasurySearch" type="text" class="ent-search-input" style="flex:1;padding:10px 16px;border:1.5px solid #d1d5db;border-radius:12px;font-family:inherit;font-size:0.875rem;outline:none;"
          placeholder="${STATE.tab === 'payouts' ? '🔍 ابحث داخل صرف الكارتات والسلفيات...' : STATE.tab === 'expenses' ? '🔍 ابحث داخل المصروفات والمرتبات...' : '🔍 ابحث داخل جميع الحركات...'}"
          value="${STATE.search[STATE.tab] || ''}">
        <button type="button" data-action="treasury-print-tab" style="background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;border-radius:12px;padding:8px 18px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;white-space:nowrap;box-shadow:0 2px 8px rgba(124,58,237,0.3);">🖨️ طباعة</button>
      </div>

      <!-- Entries Table -->
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>الوقت</th>
              <th>النوع</th>
              <th>الوصف</th>
              <th>الشخص</th>
              <th>المبلغ</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody id="treasuryTableBody"></tbody>
        </table>
      </div>
    </div>
  `;
}

function _renderSummary(summary) {
  const container = document.getElementById('treasurySummaryCards');
  if (!container) return;

  const card = (label, value, bg) => `
    <div class="flex-1 min-w-[120px] p-3 rounded-lg text-white" style="background:${bg}">
      <p class="text-xs opacity-90 mb-1" style="color:#fff">${_esc(label)}</p>
      <p class="text-xl font-bold" style="color:#fff">${Money.fmt(value)}</p>
    </div>`;

  container.innerHTML = `
    ${card('رصيد الخزنة', summary.balance, 'linear-gradient(135deg,#1e40af,#3b82f6)')}
    ${card('إجمالي الداخل', summary.total_in, 'linear-gradient(135deg,#059669,#10b981)')}
    ${card('صرف الكارتات', summary.total_payout, 'linear-gradient(135deg,#7c3aed,#8b5cf6)')}
    ${card('السلفيات', summary.total_salfa, 'linear-gradient(135deg,#0891b2,#06b6d4)')}
    ${card('المصروفات والمرتبات', summary.total_expense, 'linear-gradient(135deg,#dc2626,#ef4444)')}
  `;
}

function _renderEntries(entries) {
  const tbody = document.getElementById('treasuryTableBody');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted p-6">لا توجد حركات في هذه الفترة</td></tr>`;
    return;
  }

  const editableEffects = [EFFECTS.CAPITAL_DEPOSIT, EFFECTS.SALFA, EFFECTS.EXPENSE, EFFECTS.SALARY];

  tbody.innerHTML = entries.map(e => {
    const isEditable = editableEffects.includes(e.effect);
    const dirClass = _directionClass(e.type);
    return `
      <tr data-entry-id="${_esc(e.id)}">
        <td>${_dateDisplay(e.date)}</td>
        <td>${_timeDisplay(e.applied_at)}</td>
        <td>
          <span class="${dirClass}">${_typeIcon(e.type)} ${_effectLabel(e.effect)}</span>
        </td>
        <td>${_esc(e.description || e.note || '—')}</td>
        <td>${_esc(e.client_name || e.employee_name || '—')}</td>
        <td class="font-semibold ${dirClass}">${e.type === 'deposit' ? '+' : '-'}${Money.fmt(e.amount)}</td>
        <td>
          ${isEditable ? `
            <button type="button" data-action="treasury-edit" data-id="${e.id}" class="btn btn-secondary btn-sm">✏️</button>
            <button type="button" data-action="treasury-delete" data-id="${e.id}" class="btn btn-secondary btn-sm">🗑️</button>
          ` : `<span class="text-muted text-xs">تلقائي</span>`}
        </td>
      </tr>
    `;
  }).join('');
}

function _renderTabs() {
  const page = document.getElementById('treasuryPage');
  if (!page) return;
  page.querySelectorAll('[data-action="treasury-tab"]').forEach(btn => {
    btn.classList.toggle('active-purple', btn.dataset.tab === STATE.tab);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════════════════════

function _ensureModals() {
  if (document.getElementById('treasuryModal')) return;

  const div = document.createElement('div');
  div.innerHTML = `
    <div id="treasuryModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 id="treasuryModalTitle" class="text-lg font-bold">عملية</h3>
          <button type="button" data-action="treasury-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div id="treasuryModalBody" class="grid gap-3"></div>
        <div id="treasuryModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

function _openModal(title, bodyHTML) {
  _ensureModals();
  const modal = document.getElementById('treasuryModal');
  const titleEl = document.getElementById('treasuryModalTitle');
  const body = document.getElementById('treasuryModalBody');
  const msg = document.getElementById('treasuryModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (body) body.innerHTML = bodyHTML;
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _closeModal() {
  document.getElementById('treasuryModal')?.classList.add('hidden');
  STATE.editingId = null;
}

function _showModalError(text) {
  const msg = document.getElementById('treasuryModalMsg');
  if (msg) { msg.textContent = text; msg.classList.add('is-visible'); }
}

function _modalVal(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Modal Forms
// ═══════════════════════════════════════════════════════════════════════════════

function _openDepositModal() {
  _openModal('إيداع رأس مال', `
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositAmount">المبلغ</label>
      <input id="tDepositAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositDate">التاريخ</label>
      <input id="tDepositDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tDepositNote">ملاحظة</label>
      <input id="tDepositNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-deposit" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);
}

async function _openSalfaModal() {
  const username = _currentUsername();
  // Load clients list via repositories
  const owners = await ClientRepository.getAllOwners();
  const agents = await ClientRepository.getAgents(username);
  const clients = [
    ...owners.filter(o => o.deleted_at === null).map(o => ({ id: o.id, type: 'owner', name: o.name || '' })),
    ...agents.filter(a => a.deleted_at === null && a.agent_kind !== 'mandoub' && a.name
      && String(a.username || a.created_by || '').trim() === username)
      .map(a => ({ id: a.id, type: 'owner', name: a.name || '' })),
  ].filter(c => c.name);

  const options = clients.map(c => `<option value="${_esc(c.name)}" data-id="${c.id}" data-type="${c.type}"></option>`).join('');

  _openModal('سلفة', `
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaPerson">الشخص</label>
      <input id="tSalfaPerson" type="text" list="tSalfaClientsList" class="input input-sm" placeholder="اختر من القائمة أو اكتب اسم">
      <datalist id="tSalfaClientsList">${options}</datalist>
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaAmount">المبلغ</label>
      <input id="tSalfaAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaDate">التاريخ</label>
      <input id="tSalfaDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tSalfaNote">ملاحظة</label>
      <input id="tSalfaNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-salfa" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);

  // Store clients for lookup
  document.getElementById('tSalfaClientsList')._clients = clients;
}

function _openExpenseModal() {
  _openModal('مصروف / مرتب', `
    <div class="form-group mb-0">
      <label class="label mb-1">النوع</label>
      <div class="flex gap-3">
        <label class="flex items-center gap-1">
          <input type="radio" name="tExpenseType" value="expense" checked> مصروف
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" name="tExpenseType" value="salary"> مرتب
        </label>
      </div>
    </div>
    <div id="tExpenseDescWrap" class="form-group mb-0">
      <label class="label mb-1" for="tExpenseDesc">الوصف</label>
      <input id="tExpenseDesc" type="text" class="input input-sm" placeholder="إيجار / بنزين / صيانة...">
    </div>
    <div id="tExpenseEmpWrap" class="form-group mb-0 hidden">
      <label class="label mb-1" for="tExpenseEmp">اسم الموظف</label>
      <input id="tExpenseEmp" type="text" class="input input-sm" placeholder="اسم الموظف">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseAmount">المبلغ</label>
      <input id="tExpenseAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseDate">التاريخ</label>
      <input id="tExpenseDate" type="date" class="input input-sm" value="${_todayISO()}">
    </div>
    <div class="form-group mb-0">
      <label class="label mb-1" for="tExpenseNote">ملاحظة</label>
      <input id="tExpenseNote" type="text" class="input input-sm" placeholder="اختياري">
    </div>
    <button type="button" data-action="treasury-save-expense" class="btn btn-primary btn-full mt-2">حفظ</button>
  `);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Save Handlers
// ═══════════════════════════════════════════════════════════════════════════════

let _isSavingTreasury = false;

async function _saveDeposit() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-deposit"]');
  if (btn) btn.disabled = true;
  try {
    const amount = parseFloat(_modalVal('tDepositAmount')) || 0;
    const date = _modalVal('tDepositDate');
    const note = _modalVal('tDepositNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    await TreasuryService.depositCapital(_currentUsername(), { amount, date, note });
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

async function _saveSalfa() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-salfa"]');
  if (btn) btn.disabled = true;
  try {
    const personName = _modalVal('tSalfaPerson');
    const amount = parseFloat(_modalVal('tSalfaAmount')) || 0;
    const date = _modalVal('tSalfaDate');
    const note = _modalVal('tSalfaNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }

    // Try to match client
    let client_id = null, client_type = null, client_name = personName || null;
    const dl = document.getElementById('tSalfaClientsList');
    const clients = dl?._clients || [];
    const match = clients.find(c => c.name === personName);
    if (match) {
      client_id = String(match.id);
      client_type = match.type;
      client_name = match.name;
    }

    await TreasuryService.createSalfa(_currentUsername(), {
      client_id, client_type, client_name, amount, date, note,
    });
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

async function _saveExpense() {
  if (_isSavingTreasury) return;
  _isSavingTreasury = true;
  const btn = document.querySelector('[data-action="treasury-save-expense"]');
  if (btn) btn.disabled = true;
  try {
    const subtype = document.querySelector('input[name="tExpenseType"]:checked')?.value || 'expense';
    const description = _modalVal('tExpenseDesc');
    const employee_name = _modalVal('tExpenseEmp');
    const amount = parseFloat(_modalVal('tExpenseAmount')) || 0;
    const date = _modalVal('tExpenseDate');
    const note = _modalVal('tExpenseNote');
    if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (!date) { _showModalError('❌ التاريخ مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (subtype === 'salary' && !employee_name) { _showModalError('❌ اسم الموظف مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }
    if (subtype === 'expense' && !description) { _showModalError('❌ وصف المصروف مطلوب'); _isSavingTreasury = false; if (btn) btn.disabled = false; return; }

    await TreasuryService.createExpense(_currentUsername(), {
      subtype, description, employee_name, amount, date, note,
    });
    _closeModal();
    await _refreshPage();
  } catch (err) {
    _showModalError(err.message || '❌ حدث خطأ');
  } finally {
    _isSavingTreasury = false;
    if (btn) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Refresh
// ═══════════════════════════════════════════════════════════════════════════════



function _printTreasuryTab() {
  const tabLabels = { all: 'جميع الحركات', payouts: 'صرف كارتات وسلفيات', expenses: 'مصروفات ومرتبات' };
  const tabTitle = tabLabels[STATE.tab] || 'الخزنة';

  // Read currently displayed entries from DOM
  const tbody = document.getElementById('treasuryTableBody');
  if (!tbody) return;

  const rows = [...tbody.querySelectorAll('tr')];
  if (!rows.length) { alert('لا توجد حركات للطباعة'); return; }

  let tableRows = '';
  let totalIn = 0, totalOut = 0;

  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 6) return;
    const date = (cells[0]?.textContent || '').trim();
    const time = (cells[1]?.textContent || '').trim();
    const type = (cells[2]?.textContent || '').trim();
    const desc = (cells[3]?.textContent || '').trim();
    const person = (cells[4]?.textContent || '').trim();
    const amountText = (cells[5]?.textContent || '').trim();
    const amount = parseFloat(amountText.replace(/[^0-9.\-]/g, '')) || 0;

    if (amountText.startsWith('+')) totalIn += Math.abs(amount);
    else totalOut += Math.abs(amount);

    tableRows += `<tr>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;">${date}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;">${time}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${type}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${desc}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:right;">${person}</td>
      <td style="padding:6px 8px;border:1px solid #d1d5db;text-align:center;font-weight:700;">${amountText}</td>
    </tr>`;
  });

  // Summary row from displayed summary cards
  const summaryCards = document.querySelectorAll('#treasurySummaryCards > div');
  let summaryHTML = '';
  if (summaryCards.length) {
    summaryHTML = '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">';
    summaryCards.forEach(card => {
      const label = (card.querySelector('p:first-child')?.textContent || '').trim();
      const value = (card.querySelector('p:last-child')?.textContent || '').trim();
      summaryHTML += `<div style="flex:1;min-width:100px;border:1px solid #cbd5e1;border-radius:6px;padding:8px 12px;text-align:center;"><div style="font-size:8pt;color:#6b7280;">${label}</div><div style="font-size:14pt;font-weight:800;color:#1e3a8a;">${value}</div></div>`;
    });
    summaryHTML += '</div>';
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('ar-EG', { dateStyle: 'full' });
  const timeStr = now.toLocaleTimeString('ar-EG', { timeStyle: 'short' });

  const body = `
    <div style="text-align:center;margin-bottom:16px;border-bottom:2px solid #1e3a8a;padding-bottom:10px;">
      <h2 style="margin:0;color:#1e3a8a;font-size:16pt;">الخزنة — ${tabTitle}</h2>
      <p style="margin:4px 0 0;color:#6b7280;font-size:9pt;">${dateStr} — ${timeStr}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">التاريخ</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الوقت</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">النوع</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الوصف</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">الشخص</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #1e3a8a;font-size:9pt;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;">المبلغ</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    ${summaryHTML}`;

  printHTML(buildPrintDocument({
    title: 'طباعة الخزنة — ' + tabTitle,
    body,
    orientation: 'landscape',
  }), { id: 'treasury-print-iframe' });
}

function _computeFilteredSummary(entries, username) {
  let total_in = 0;
  let total_payout = 0;
  let total_salfa = 0;
  let total_expense = 0;

  for (const e of entries) {
    const amt = Money.toCents(e.amount);
    if (e.type === 'deposit') total_in += amt;
    if (e.effect === EFFECTS.RECEIPT_PAYOUT) total_payout += amt;
    if (e.effect === EFFECTS.SALFA) total_salfa += amt;
    if (e.effect === EFFECTS.EXPENSE || e.effect === EFFECTS.SALARY) total_expense += amt;
  }

  // Balance is always full (not filtered) — get from TreasuryService cache
  // But for filtered view, compute from these entries only
  let balance_in = 0, balance_out = 0;
  for (const e of entries) {
    const amt = Money.toCents(e.amount);
    if (e.type === 'deposit') balance_in += amt;
    if (e.type === 'withdraw') balance_out += amt;
  }

  return {
    balance: Money.toDecimal(balance_in - balance_out),
    total_in: Money.toDecimal(total_in),
    total_payout: Money.toDecimal(total_payout),
    total_salfa: Money.toDecimal(total_salfa),
    total_expense: Money.toDecimal(total_expense),
  };
}

async function _refreshPage() {
  const username = _currentUsername();
  const filters = { from: STATE.from, to: STATE.to, tab: STATE.tab };

  const allEntries = await TreasuryService.getEntries(username, filters);

  // Apply search filter
  const query = (STATE.search[STATE.tab] || '').trim().toLowerCase();
  const filteredEntries = query
    ? allEntries.filter(e => {
        const hay = [
          e.note, e.description, e.client_name, e.employee_name,
          e.receipt_number, _effectLabel(e.effect),
          String(e.amount), e.date, e.reference_id,
        ].join(' ').toLowerCase();
        return hay.includes(query);
      })
    : allEntries;

  // Compute summary from filtered entries only
  const filteredSummary = _computeFilteredSummary(filteredEntries, username);
  _renderSummary(filteredSummary);

  _renderEntries(filteredEntries);
  _renderTabs();

  // Sync inputs
  const fromEl = document.getElementById('treasuryFrom');
  const toEl = document.getElementById('treasuryTo');
  if (fromEl) fromEl.value = STATE.from || '';
  if (toEl) toEl.value = STATE.to || '';

  // Sync search input
  const searchEl = document.getElementById('treasurySearch');
  if (searchEl) searchEl.value = STATE.search[STATE.tab] || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════════

function _injectStyles() {
  if (document.getElementById('treasury-module-styles')) return;
  const style = document.createElement('style');
  style.id = 'treasury-module-styles';
  style.textContent = `
    .treasury-in { color: #059669; }
    .treasury-out { color: #dc2626; }
  `;
  document.head.appendChild(style);
}

let _bound = false;

function attachTreasuryListeners() {
  if (_bound) return;
  _bound = true;

  document.addEventListener('click', async (e) => {
    // Deposit
    if (e.target.closest('[data-action="treasury-deposit"]')) {
      _openDepositModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-deposit"]')) {
      await _saveDeposit();
      return;
    }

    // Salfa
    if (e.target.closest('[data-action="treasury-salfa"]')) {
      await _openSalfaModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-salfa"]')) {
      await _saveSalfa();
      return;
    }

    // Expense
    if (e.target.closest('[data-action="treasury-expense"]')) {
      _openExpenseModal();
      return;
    }
    if (e.target.closest('[data-action="treasury-save-expense"]')) {
      await _saveExpense();
      return;
    }

    // Modal close
    if (e.target.closest('[data-action="treasury-modal-close"]')) {
      _closeModal();
      return;
    }

    // Tabs
    const tabBtn = e.target.closest('[data-action="treasury-tab"]');
    if (tabBtn) {
      STATE.tab = tabBtn.dataset.tab || 'all';
      await _refreshPage();
      return;
    }

    // Date range
    const rangeBtn = e.target.closest('[data-action="treasury-range"]');
    if (rangeBtn) {
      _setQuickRange(Number(rangeBtn.dataset.days) || 30);
      await _refreshPage();
      return;
    }

    // Apply filter
    if (e.target.closest('[data-action="treasury-apply-filter"]')) {
      STATE.from = document.getElementById('treasuryFrom')?.value || '';
      STATE.to = document.getElementById('treasuryTo')?.value || '';
      await _refreshPage();
      return;
    }

    // Clear filter
    if (e.target.closest('[data-action="treasury-clear-filter"]')) {
      STATE.from = '';
      STATE.to = '';
      await _refreshPage();
      return;
    }

    // Delete entry
    const delBtn = e.target.closest('[data-action="treasury-delete"]');
    if (delBtn) {
      if (!confirm('هل تريد حذف هذه الحركة؟')) return;
      try {
        await TreasuryService.deleteEntry(_currentUsername(), delBtn.dataset.id);
        await _refreshPage();
      } catch (err) {
        alert(err.message || '❌ حدث خطأ');
      }
      return;
    }

    // Edit entry
    const editBtn = e.target.closest('[data-action="treasury-edit"]');
    if (editBtn) {
      const entryId = editBtn.dataset.id;
      const entry = await TreasuryRepository.getById(entryId);
      if (!entry) return;
      const dec = Money.decimalizeRecord(entry);

      STATE.editingId = entryId;
      _openModal('تعديل الحركة', `
        <div class="form-group mb-0">
          <label class="label mb-1">النوع</label>
          <input type="text" class="input input-sm" value="${_esc(_effectLabel(entry.effect))}" disabled>
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditAmount">المبلغ</label>
          <input id="tEditAmount" type="number" min="0" step="0.01" class="input input-sm" value="${dec.amount}">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditDate">التاريخ</label>
          <input id="tEditDate" type="date" class="input input-sm" value="${_dateDisplay(entry.date)}">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-1" for="tEditNote">ملاحظة</label>
          <input id="tEditNote" type="text" class="input input-sm" value="${_esc(entry.note || '')}">
        </div>
        <button type="button" data-action="treasury-save-edit" class="btn btn-primary btn-full mt-2">حفظ التعديل</button>
      `);
      return;
    }

    // Save edit
    if (e.target.closest('[data-action="treasury-save-edit"]')) {
      if (!STATE.editingId) return;
      try {
        const amount = parseFloat(_modalVal('tEditAmount')) || 0;
        const date = _modalVal('tEditDate');
        const note = _modalVal('tEditNote');
        if (amount <= 0) { _showModalError('❌ المبلغ مطلوب'); return; }
        await TreasuryService.editEntry(_currentUsername(), STATE.editingId, { amount, date, note });
        _closeModal();
        await _refreshPage();
      } catch (err) {
        _showModalError(err.message || '❌ حدث خطأ');
      }
      return;
    }
  });

  // Expense type radio toggle
  document.addEventListener('change', (e) => {
    if (e.target.name === 'tExpenseType') {
      const isSalary = e.target.value === 'salary';
      document.getElementById('tExpenseDescWrap')?.classList.toggle('hidden', isSalary);
      document.getElementById('tExpenseEmpWrap')?.classList.toggle('hidden', !isSalary);
    }
  });

  // Print tab
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="treasury-print-tab"]')) {
      _printTreasuryTab();
    }
  });

  // Search input
  document.addEventListener('input', (e) => {
    if (e.target.id === 'treasurySearch') {
      STATE.search[STATE.tab] = e.target.value;
      _refreshPage();
    }
  });

  // Listen for external changes
  window.addEventListener('treasury:changed', () => {
    const page = document.getElementById('treasuryPage');
    if (page && !page.classList.contains('hidden')) {
      _refreshPage();
    }
  });
  window.addEventListener('receipts:changed', () => {
    const page = document.getElementById('treasuryPage');
    if (page && !page.classList.contains('hidden')) {
      _refreshPage();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════════

function initTreasuryPage() {
  _injectStyles();
  _renderShell();
  attachTreasuryListeners();
  _refreshPage();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════════════════════

export { TreasuryService, initTreasuryPage, attachTreasuryListeners };
