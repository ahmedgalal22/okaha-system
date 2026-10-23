/**
 * entities.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { DB } from './database.js';
import { FinancialService } from './financial.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { printHTML } from './printEngine.js';
import { ExcelService } from './excelService.js';


// ========================================
// Services — AgentsService
// ========================================


function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function _todayISO() {
  return new Date().toISOString().split('T')[0];
}

function _resolveUsername(username, context) {
  const clean = typeof username === 'string' ? username.trim() : '';
  if (clean) return clean;
  const session = AuthModule.getSession();
  const sessionUser = typeof session?.username === 'string' ? session.username.trim() : '';
  if (!sessionUser) {
    throw new Error(`[${context}] username is required.`);
  }
  return sessionUser;
}

function _agentOwner(record) {
  const direct = typeof record?.username === 'string' ? record.username.trim() : '';
  if (direct) return direct;
  const created = typeof record?.created_by === 'string' ? record.created_by.trim() : '';
  if (created) return created;
  return null;
}

function _isAgentOwnedBy(record, username) {
  const owner = _agentOwner(record);
  return owner !== null && owner === String(username);
}

// getAllBrokers removed — broker tab eliminated

async function getAllMandoubs(username = null) {
  const owner = _resolveUsername(username, 'AgentsService:getAllMandoubs');
  const all = await DB.getAll('agents');
  return all.filter(a =>
    a.deleted_at === null
    && a.agent_kind === 'mandoub'
    && _isAgentOwnedBy(a, owner)
  );
}

async function getMandoubById(agent_id, username = null) {
  if (!agent_id) return null;
  const owner = _resolveUsername(username, 'AgentsService:getMandoubById');
  const key = Number.isNaN(Number(agent_id)) ? agent_id : Number(agent_id);
  const a = await DB.getById('agents', key);
  if (!a || a.deleted_at !== null) return null;
  if (a.agent_kind !== 'mandoub') return null;
  if (!_isAgentOwnedBy(a, owner)) return null;
  return a;
}

async function _mandoubLedger(agent_id) {
  // Reuse treasury as the ledger store (no new stores allowed).
  const key = String(agent_id);
  const bolsaEntries = await DB.findByFields('treasury', {
    is_reversed: false,
    reference_type: 'bolsa',
    agent_id: key,
  });
  const balanceEntries = await DB.findByFields('treasury', {
    is_reversed: false,
    reference_type: 'mandoub_balance',
    agent_id: key,
  });
  const entries = [...bolsaEntries, ...balanceEntries];
  return entries
    .slice()
    .sort((a, b) => new Date(b.date || b.applied_at || b.created_at || 0) - new Date(a.date || a.applied_at || a.created_at || 0));
}

async function getMandoubSnapshot(agent_id) {
  const agent = await getMandoubById(agent_id);
  if (!agent) throw new Error('❌ المندوب غير موجود');
  const ledger = await _mandoubLedger(agent.id);
  let total_withdraw = 0;
  let total_deposit = 0;
  for (const e of ledger) {
    const amount = Money.toDecimal(e.amount); // treasury stores cents
    if (e.type === 'withdraw') total_withdraw += amount;
    if (e.type === 'deposit') total_deposit += amount;
  }
  const balance = Money.round(Number(agent.balance || 0));
  return {
    agent,
    balance,
    total_withdraw: Money.round(total_withdraw),
    total_deposit: Money.round(total_deposit),
    ledger,
  };
}

async function deductFromAgent(username, agent_id, amount, bolsa_id, date = null) {
  if (!username) throw new Error('[AgentsService:deductFromAgent] username is required.');

  const amt = Money.round(amount);
  if (amt <= 0) throw new Error('❌ قيمة الخصم يجب أن تكون أكبر من صفر');

  const isoDate = (date && !Number.isNaN(Date.parse(date))) ? date : _todayISO();
  const cents = Money.toCents(amt);

  return DB.transaction(async (tx) => {
    const key = Number.isNaN(Number(agent_id)) ? agent_id : Number(agent_id);
    const agent = await tx.getById('agents', key);
    if (!agent || agent.deleted_at !== null || agent.agent_kind !== 'mandoub' || !_isAgentOwnedBy(agent, username)) {
      throw new Error('❌ يجب اختيار مندوب صحيح');
    }

    const newBal = Money.round((Number(agent.balance) || 0) - amt);

    const ops = [
      { op: 'update', store: 'agents', id: agent.id, patch: { balance: newBal } },
      {
        op: 'add',
        store: 'treasury',
        payload: {
          username,
          type: 'withdraw',
          effect: 'bolsa_deduction',
          amount: cents,
          account_type: 'cash',
          reference_type: 'bolsa',
          reference_id: bolsa_id,
          agent_id: String(agent.id),
          client_id: String(agent.id),
          client_type: 'mandoub',
          client_name: agent.name || null,
          date: isoDate,
          applied_at: new Date().toISOString(),
          is_reversed: false,
          note: `خصم مندوب من تفريغ البوالص (${String(bolsa_id)})`,
        },
      },
    ];

    const [updatedAgent, ledgerEntry] = await tx.runOps(ops);
    return { agent: updatedAgent, ledger: ledgerEntry };
  }, { username, stores: ['agents', 'treasury'] });
}

/**
 * adjustMandoubBalance(username, agent_id, type, amount, date, note, fromTreasury)
 *
 * type = 'deposit'  → المندوب يأخد فلوس (رصيده يزيد)
 * type = 'withdraw' → المندوب يرجّع فلوس (رصيده يقل)
 *
 * fromTreasury:
 *   true  → الفلوس من/إلى الدُّرج (يُسجّل في treasury)
 *   false → تعديل رصيد فقط بدون حركة كاش (مثال: تصحيح رصيد)
 *   default: true
 *
 * Treasury direction (من منظور الخزنة):
 *   deposit  للمندوب → withdraw من الخزنة (كاش طلع من الدُّرج)
 *   withdraw من المندوب → deposit في الخزنة (كاش رجع للدُّرج)
 */
async function adjustMandoubBalance(username, agent_id, type, amount, date = null, note = '', fromTreasury = true) {
  if (!username) throw new Error('[AgentsService:adjustMandoubBalance] username is required.');
  const t = type === 'withdraw' ? 'withdraw' : 'deposit';
  const amt = Money.round(amount);
  if (amt <= 0) throw new Error('❌ المبلغ يجب أن يكون أكبر من صفر');
  const isoDate = (date && !Number.isNaN(Date.parse(date))) ? date : _todayISO();
  const now = new Date().toISOString();

  const delta = t === 'withdraw' ? -amt : amt;
  const cents = Money.toCents(amt);
  const refId = _uuid();

  // Treasury direction is OPPOSITE of mandoub direction:
  //   mandoub deposit  (gets money)   → treasury withdraw (cash leaves drawer)
  //   mandoub withdraw (returns money) → treasury deposit  (cash enters drawer)
  const treasuryType = t === 'deposit' ? 'withdraw' : 'deposit';
  const treasuryEffect = t === 'deposit' ? 'mandoub_cash_out' : 'mandoub_cash_in';

  const result = await DB.transaction(async (tx) => {
    const key = Number.isNaN(Number(agent_id)) ? agent_id : Number(agent_id);
    const agent = await tx.getById('agents', key);
    if (!agent || agent.deleted_at !== null || agent.agent_kind !== 'mandoub' || !_isAgentOwnedBy(agent, username)) {
      throw new Error('❌ المندوب غير موجود');
    }

    const newBal = Money.round((Number(agent.balance) || 0) + delta);

    const ops = [
      { op: 'update', store: 'agents', id: agent.id, patch: { balance: newBal } },
    ];

    // Treasury entry: only if cash actually moved from/to the drawer
    if (fromTreasury) {
      ops.push({
        op: 'add',
        store: 'treasury',
        payload: {
          username,
          type: treasuryType,
          effect: treasuryEffect,
          amount: cents,
          account_type: 'cash',
          reference_type: 'mandoub_balance',
          reference_id: refId,
          agent_id: String(agent.id),
          client_id: String(agent.id),
          client_type: 'mandoub',
          client_name: agent.name || null,
          date: isoDate,
          applied_at: now,
          is_reversed: false,
          note: String(note || '').trim() || (t === 'deposit' ? 'إيداع للمندوب' : 'استلام من المندوب'),
        },
      });
    }

    const results = await tx.runOps(ops);
    return { agent: results[0], ledger: results[1] || null };
  }, { username, stores: ['agents', 'treasury'] });
  window.dispatchEvent(new CustomEvent('agents:changed'));
  return result;
}

const AgentsService = Object.freeze({
  getAllMandoubs,
  getMandoubById,
  getMandoubSnapshot,
  deductFromAgent,
  adjustMandoubBalance,
});



// ========================================
// Services — Vehicles
// ========================================

function _normalizePlate(rawPlate) {
  return String(rawPlate ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolveVehicle(username, rawPlate, owner = null) {
  if (!username) throw new Error('[VehiclesModule:resolveVehicle] username is required.');
  const normalizedPlate = _normalizePlate(rawPlate);

  if (!normalizedPlate) {
    throw new Error('رقم المركبة مطلوب');
  }

  const existing = await DB.findByFields('vehicles', { plate: normalizedPlate });

  if (existing.length > 0) {
    const vehicle = existing[0];
    if (!vehicle.owner_id && owner?.id) {
      return DB.update('vehicles', vehicle.id, {
        owner_id: String(owner.id),
        owner_name: owner.name || null,
      }, { username });
    }
    return vehicle;
  }

  if (!owner?.id) {
    throw new Error('يجب تحديد مالك المركبة قبل تسجيل المركبة');
  }

  const vehicle = await DB.add('vehicles', {
    id: crypto.randomUUID(),
    plate: normalizedPlate,
    owner_id: String(owner.id),
    owner_name: owner.name || null,
    notes: null,
  }, { username });

  return vehicle;
}

const VehiclesModule = { resolveVehicle };

window.VehiclesModule = VehiclesModule;



// ========================================
// Services — OwnersModule
// ========================================

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _emitOwnersChanged() {
  window.dispatchEvent(new CustomEvent('owners:changed'));
}

async function createOwner(username, payload) {
  if (!username) throw new Error('[OwnersModule:createOwner] username is required.');
  const name = _toText(payload?.name).trim();
  const phone = _toText(payload?.phone).trim();
  const notes = _toText(payload?.notes).trim();

  if (!name) {
    throw new Error('اسم صاحب المركبة مطلوب');
  }

  const exists = await DB.findByFields('vehicleOwners', { name });
  if (exists.length > 0) {
    throw new Error('اسم صاحب المركبة مستخدم بالفعل');
  }

  const record = await DB.add('vehicleOwners', {
    id: _uuid(),
    username,
    name,
    phone: phone || null,
    notes: notes || null,
  }, { username });

  _emitOwnersChanged();
  return record;
}

async function getAllOwners() {
  return DB.getAll('vehicleOwners');
}

async function updateOwner(username, id, patch) {
  if (!username) throw new Error('[OwnersModule:updateOwner] username is required.');
  if (!id) throw new Error('معرّف صاحب المركبة مطلوب');
  const name = patch?.name === undefined ? undefined : _toText(patch.name).trim();
  const notes = patch?.notes === undefined ? undefined : _toText(patch.notes).trim();

  if (name !== undefined) {
    if (!name) throw new Error('اسم صاحب المركبة مطلوب');
    const exists = (await DB.findByFields('vehicleOwners', { name }))
      .filter(o => o.id !== id);
    if (exists.length > 0) {
      throw new Error('اسم صاحب المركبة مستخدم بالفعل');
    }
  }

  const updated = await DB.update('vehicleOwners', id, {
    ...(name !== undefined ? { name } : {}),
    ...(notes !== undefined ? { notes: notes || null } : {}),
  }, { username });

  _emitOwnersChanged();
  return updated;
}

async function deleteOwner(username, id) {
  if (!username) throw new Error('[OwnersModule:deleteOwner] username is required.');
  if (!id) throw new Error('معرّف صاحب المركبة مطلوب');

  // Receipts contain immutable snapshots with owner_name — safe to delete entity
  const deleted = await DB.delete('vehicleOwners', id, { username });
  _emitOwnersChanged();
  return deleted;
}

async function getOwnerById(id) {
  if (!id) return null;
  const owner = await DB.getById('vehicleOwners', id);
  if (!owner || owner.deleted_at !== null) return null;
  return owner;
}



async function getClientsByTab(tab) {
  const owners = await DB.getAll('vehicleOwners');
  return owners
    .filter(o => o.deleted_at === null)
    .map(o => ({ id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null }))
    .filter(x => x.name);
}

async function getClientByType(type, id) {
  if (type === 'broker') {
    const key = Number.isNaN(Number(id)) ? id : Number(id);
    const agent = await DB.getById('agents', key);
    if (!agent || agent.deleted_at !== null) return null;
    return { id: String(agent.id), type: 'broker', name: agent.name || '', phone: agent.phone || null };
  }
  const owner = await DB.getById('vehicleOwners', String(id));
  return owner ? { id: String(owner.id), type: 'owner', name: owner.name || '', phone: owner.phone || null } : null;
}

async function getClientBalance(client_id) {
  return FinancialService.getClientBalance(client_id);
}

async function getClientLedger(client_id) {
  return FinancialService.getClientLedger(client_id);
}

async function createClientBalanceEntry(username, payload) {
  return FinancialService.createClientBalanceEntry(username, payload);
}

async function getOwnerVehicles(owner_id) {
  const vehicles = await DB.getAll('vehicles');
  return vehicles.filter(v => String(v.owner_id || '') === String(owner_id));
}

async function getAgentReceipts(agent_id) {
  const receipts = await DB.getAll('receipts');
  return receipts
    .filter(r =>
      r.deleted_at === null &&
      (
        (r.client_type === 'agent' && String(r.client_id) === String(agent_id)) ||
        String(r.agent_id || '') === String(agent_id)
      )
    )
    .sort((a, b) => new Date(b.receipt_date || 0) - new Date(a.receipt_date || 0));
}

async function addAccount(username, kind, payload) {
  if (!username) throw new Error('[OwnersModule:addAccount] username is required.');
  const name = _toText(payload?.name).trim();
  const notes = _toText(payload?.notes).trim();
  if (!name) throw new Error('❌ الاسم مطلوب');

  if (kind === 'mandoub') {
    const all = await DB.findByFields('agents', {
      agent_kind: 'mandoub',
    });
    const exists = all.filter(a => String(a.name || '').trim().toLowerCase() === name.toLowerCase());
    if (exists.length > 0) throw new Error('اسم المندوب مستخدم بالفعل');
    await DB.add('agents', { username, name, phone: payload?.phone || null, balance: 0, agent_kind: 'mandoub' }, { username });
    window.dispatchEvent(new CustomEvent('agents:changed'));
    return;
  }

  await createOwner(username, { name, phone: payload?.phone || null, notes });
}


// ─── DEPRECATED PROXIES (delegate to FinancialService) ─────────────────────
// getOwnerBalance was removed — it ignored receipt_due entries and returned wrong results.
// These proxies maintain backward compatibility for any external callers.
const getOwnerBalance = (id) => FinancialService.getClientBalance(id).then(s => s.balance);
const getOwnerLedger = (id) => FinancialService.getClientLedger(id);

const OwnersModule = Object.freeze({
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getOwnerBalance,
  getOwnerLedger,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  getAgentReceipts,
  addAccount,
  getMandoubSnapshot: (agent_id) => AgentsService.getMandoubSnapshot(String(agent_id)),
  getAllMandoubs: () => AgentsService.getAllMandoubs(),
  adjustMandoubBalance: (username, agent_id, entryType, amount, date, note, fromTreasury) =>
    AgentsService.adjustMandoubBalance(username, String(agent_id), entryType, amount, date, note, fromTreasury),
});

window.OwnersModule = OwnersModule;



// ========================================
// Owners Page — Rendering / Events
// ========================================

let _activeAccountTab = 'customers'; // customers | mandoubs
let _selectedClient = null;
let _balanceActionType = 'deposit';
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';

function _fmt(n) {
  return Money.fmt(n);
}

function _dateLabel(value) {
  if (!value) return '-';
  return String(value).split('T')[0] || '-';
}

function _ledgerType(type) {
  if (type === 'deposit') return 'إضافة';
  if (type === 'withdraw') return 'سداد';
  if (type === 'receipt_due') return 'صافي مستحق';
  if (type === 'receipt_payment') return 'صرف نموذج';
  if (type === 'OFFICE_DEPOSIT') return 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return 'سحب شركة';
  return type || '-';
}

function _ledgerNote(entry) {
  const receiptNum = entry.receipt_number || '';
  const refType = entry.reference_type || '';
  const type = entry.type || '';
  const note = entry.note || '';

  // Receipt due — نموذج صرف أُضيف
  if (type === 'receipt_due') {
    return receiptNum ? 'إيداع نموذج صرف — إذن: ' + receiptNum : 'إيداع نموذج صرف';
  }
  // Receipt payment — نموذج صرف تم صرفه
  if (type === 'receipt_payment') {
    return receiptNum ? 'سحب نموذج صرف — إذن: ' + receiptNum : 'سحب نموذج صرف';
  }
  // Client balance — manual deposit/withdraw
  if (refType === 'client_balance') {
    if (type === 'deposit') return note || 'إيداع رصيد يدوي';
    if (type === 'withdraw') return note || 'سحب رصيد يدوي';
  }
  // Salfa
  if (refType === 'salfa') {
    return note || 'سلفة';
  }
  // Office entries
  if (type === 'OFFICE_DEPOSIT') return note || 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return note || 'سحب شركة';
  // Generic
  if (note) return note;
  return _ledgerType(type);
}

function _balanceClass(balance) {
  if (Number(balance) < 0) return 'balance-negative';
  if (Number(balance) > 0) return 'balance-positive';
  return '';
}

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

function _kindLabel(type) {
  if (type === 'owner') return 'صاحب مركبة';
  if (type === 'mandoub') return 'مندوب';
  return '-';
}

async function _clientSnapshot(client) {
  const balance = await OwnersModule.getClientBalance(client.id);
  // last_activity = most recent of: entity update OR financial transaction
  const entityTime = Number(client.updated_at || client.created_at || 0);
  const txTime = balance.last_transaction_date
    ? new Date(balance.last_transaction_date).getTime() || 0
    : 0;
  const lastActivity = Math.max(entityTime, txTime);
  return {
    ...client,
    phone: client.phone || null,
    balance: balance.balance,
    last_transaction_date: balance.last_transaction_date,
    updated_at: entityTime,
    last_activity: lastActivity,
  };
}

async function _loadTabClients() {
  return OwnersModule.getClientsByTab(_activeAccountTab);
}


function _renderShell() {
  const page = document.getElementById('ownersPage');
  if (!page) return;

  const isCustomers = _activeAccountTab === 'customers';

  page.innerHTML = isCustomers ? _renderCustomersShell() : _renderMandoubsShell();
}

function _renderCustomersShell() {
  return `
    <!-- البطاقة العلوية -->
    <div class="ent-top-card">
      <div class="ent-header-row">
        <h2 class="ent-page-title">إدارة أصحاب المركبات والوسطاء</h2>
        <div class="ent-header-actions">
          <div class="ent-dropdown-wrap" id="addNameDropdownWrap">
            <button type="button" data-action="toggle-add-dropdown" class="ent-btn-add">➕ إضافة اسم</button>
            <div id="addNameDropdown" class="hidden ent-dropdown">
              <button type="button" data-action="add-owner-type" data-kind="owner" class="ent-dropdown-item ent-dropdown-item--blue">🚗 صاحب مركبة</button>
              <button type="button" data-action="add-owner-type" data-kind="broker" class="ent-dropdown-item ent-dropdown-item--purple">💼 وسيط</button>
            </div>
          </div>
          <button type="button" data-action="print-owners" class="ent-btn-print">🖨️ طباعة</button>
          <button type="button" data-action="export-owners-excel" class="ent-btn-print" style="background:#0f766e;" title="تصدير أصحاب المركبات والوسطاء إلى Excel">📤 تصدير Excel</button>
          <button type="button" data-action="import-owners-excel" class="ent-btn-print" style="background:#7c3aed;" title="استيراد أصحاب المركبات والوسطاء من Excel">📥 استيراد Excel</button>
        </div>
      </div>

      <!-- التبويبات -->
      <div class="ent-tabs">
        <button type="button" data-account-tab="customers" class="ent-tab ent-tab--active">أصحاب المركبات والوسطاء</button>
        <button type="button" data-account-tab="mandoubs" class="ent-tab">المناديب</button>
      </div>

      <!-- شريط البحث -->
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;" class="ent-search-wrap">
        <input id="ownerSearchInput" type="text" class="ent-search-input" placeholder="🔍 ابحث عن صاحب مركبة أو وسيط..." style="flex:1;min-width:200px;">
        <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:8px 20px;border-radius:12px;font-weight:700;font-size:0.875rem;white-space:nowrap;">
          الرصيد الكلي: <span id="totalBalanceDisplay">0.00</span>
        </div>
      </div>

      <!-- زر طباعة المحدد -->

    </div>

    <!-- القائمتان -->
    <div class="ent-columns-grid" id="ownersColumnsGrid">
      <!-- عمود أصحاب المركبات -->
      <div class="ent-column-card">
        <div class="ent-column-header">
          <h3 class="ent-column-title ent-column-title--blue">🚗 أصحاب المركبات</h3>
        </div>
        <div class="table-wrapper ent-column-scroll">
          <table class="table">
            <thead style="background:linear-gradient(135deg,#2563eb,#1d4ed8);">
              <tr>
                <th style="color:#fff;">الاسم</th>
                <th style="color:#fff;">الهاتف</th>
                <th style="color:#fff;">الرصيد</th>
                <th style="color:#fff;">كارتات</th>
                <th style="color:#fff;">إجراءات</th>
              </tr>
            </thead>
            <tbody id="ownersTableBody"></tbody>
          </table>
        </div>
      </div>

      <!-- عمود الوسطاء -->
      <div class="ent-column-card">
        <div class="ent-column-header">
          <h3 class="ent-column-title ent-column-title--purple">💼 الوسطاء</h3>
        </div>
        <div class="table-wrapper ent-column-scroll">
          <table class="table">
            <thead style="background:linear-gradient(135deg,#7c3aed,#6d28d9);">
              <tr>
                <th style="color:#fff;">الاسم</th>
                <th style="color:#fff;">الهاتف</th>
                <th style="color:#fff;">الرصيد</th>
                <th style="color:#fff;">كارتات</th>
                <th style="color:#fff;">إجراءات</th>
              </tr>
            </thead>
            <tbody id="brokersTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function _renderMandoubsShell() {
  return `
    <div class="ent-top-card">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
        <h2 style="font-size:1.5rem;font-weight:800;color:#1f2937;margin:0;">إدارة المناديب</h2>
        <button type="button" data-action="add-mandoub-btn" style="background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;border:none;border-radius:12px;padding:8px 18px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;box-shadow:0 2px 8px rgba(15,118,110,0.3);">➕ إضافة مندوب</button>
      </div>

      <!-- التبويبات -->
      <div style="display:flex;border-bottom:2px solid #e5e7eb;margin-bottom:16px;">
        <button type="button" data-account-tab="customers" style="padding:14px 28px;border:none;border-bottom:3px solid transparent;background:transparent;color:#9ca3af;font-weight:500;font-size:0.9375rem;cursor:pointer;font-family:inherit;">أصحاب المركبات والوسطاء</button>
        <button type="button" data-account-tab="mandoubs" style="padding:14px 28px;border:none;border-bottom:3px solid #1f2937;background:#f3f4f6;color:#1f2937;font-weight:700;font-size:0.9375rem;cursor:pointer;font-family:inherit;margin-left:8px;">المناديب</button>
      </div>
    </div>

    <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);overflow:hidden;">
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>الاسم</th>
              <th>رقم الهاتف</th>
              <th>الرصيد</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody id="customersTable"></tbody>
        </table>
      </div>
    </div>
  `;
}


let _addModalKind = 'owner';
let _editingAccountId = null;
let _editingAccountKind = null;


function _openEditModal(id, kind, currentName, currentPhone) {
  // Ensure modal exists first (before setting edit state)
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    _openAddModal('temp', kind);
    modal = document.getElementById('ownerAddModal');
    modal?.classList.add('hidden');
  }

  // NOW set edit state (after modal creation won't reset it)
  _addModalKind = kind;
  _editingAccountId = id;
  _editingAccountKind = kind;

  const header = document.getElementById('addModalHeader');
  if (header) {
    if (kind === 'broker') header.style.background = 'linear-gradient(135deg,#7c3aed,#6d28d9)';
    else if (kind === 'mandoub') header.style.background = 'linear-gradient(135deg,#0f766e,#0d9488)';
    else header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  }
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '✏️ تعديل البيانات';

  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = `<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم" value="${currentName || ''}"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف" value="${currentPhone || ''}"></td><td></td></tr>`;

  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _openAddModal(title, kind) {
  _addModalKind = kind;
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="ownerAddModal" class="hidden fixed inset-0 flex items-center justify-center z-50 p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);">
        <div style="background:#fff;border-radius:24px;box-shadow:0 25px 50px rgba(0,0,0,0.25);width:100%;max-width:32rem;max-height:90vh;overflow:auto;">
          <div id="addModalHeader" style="padding:20px 24px;border-radius:24px 24px 0 0;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;">
            <div>
              <h3 style="color:#fff;font-size:1.25rem;font-weight:700;margin:0;" id="addModalTitle">➕ إضافة اسم</h3>
              <p style="color:rgba(255,255,255,0.8);font-size:0.8125rem;margin:4px 0 0;">أدخل البيانات ثم اضغط حفظ</p>
            </div>
            <button type="button" data-action="close-add-modal" style="background:rgba(255,255,255,0.2);border:none;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:1.125rem;">✕</button>
          </div>
          <div style="padding:20px 24px;">
            <div class="table-wrapper mb-4">
              <table class="table"><thead><tr><th>الاسم</th><th>رقم الهاتف</th><th>حذف</th></tr></thead>
              <tbody id="addModalRows">
                <tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>
              </tbody></table>
            </div>
            <div class="flex gap-2">
              <button type="button" data-action="add-modal-add-row" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة صف</button>
              <button type="button" data-action="save-add-modal" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">💾 حفظ</button>
              <button type="button" data-action="close-add-modal" class="btn btn-secondary btn-sm">إلغاء</button>
            </div>
            <div id="addModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
    modal = document.getElementById('ownerAddModal');
  }

  // Set header color based on kind
  const header = document.getElementById('addModalHeader');
  if (header) {
    if (kind === 'broker') header.style.background = 'linear-gradient(135deg,#7c3aed,#6d28d9)';
    else if (kind === 'mandoub') header.style.background = 'linear-gradient(135deg,#0f766e,#0d9488)';
    else header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  }
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '➕ إضافة ' + title;

  // Reset rows
  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = '<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>';
  _editingAccountId = null;
  _editingAccountKind = null;
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal.classList.remove('hidden');
}

async function _saveFromAddModal() {
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  // ── EDIT MODE ──
  if (_editingAccountId) {
    const nameVal = (document.querySelector('#addModalRows .add-m-name')?.value || '').trim();
    const phoneVal = (document.querySelector('#addModalRows .add-m-phone')?.value || '').trim() || null;
    if (!nameVal) { if (msg) { msg.textContent = '❌ الاسم مطلوب'; msg.classList.add('is-visible'); } return; }
    try {
      if (_editingAccountKind === 'owner') {
        await OwnersModule.updateOwner(_currentUsername(), _editingAccountId, { name: nameVal });
        // Update phone separately
        await DB.update('vehicleOwners', _editingAccountId, { phone: phoneVal }, { username: _currentUsername() });
        window.dispatchEvent(new CustomEvent('owners:changed'));
      } else {
        const key = Number.isNaN(Number(_editingAccountId)) ? _editingAccountId : Number(_editingAccountId);
        await DB.update('agents', key, { name: nameVal, phone: phoneVal }, { username: _currentUsername() });
        window.dispatchEvent(new CustomEvent('agents:changed'));
      }
    } catch (err) { if (msg) { msg.textContent = err.message; msg.classList.add('is-visible'); } return; }
    _editingAccountId = null;
    _editingAccountKind = null;
    document.getElementById('ownerAddModal')?.classList.add('hidden');
    await loadOwners();
    return;
  }

  // ── ADD MODE ──
  const rows = [...document.querySelectorAll('#addModalRows tr')];
  const entries = rows.map(tr => ({
    name: (tr.querySelector('.add-m-name')?.value || '').trim(),
    phone: (tr.querySelector('.add-m-phone')?.value || '').trim() || null,
  })).filter(e => e.name);

  if (entries.length === 0) {
    if (msg) { msg.textContent = '❌ أدخل اسم واحد على الأقل'; msg.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  for (const entry of entries) {
    try {
      if (_addModalKind === 'broker') {
        // Save as agent with broker kind
        const all = await DB.getAll('agents');
        const exists = all.filter(a => a.deleted_at === null && a.agent_kind !== 'mandoub' && String(a.name || '').trim().toLowerCase() === entry.name.toLowerCase());
        if (exists.length > 0) throw new Error('الاسم مستخدم بالفعل: ' + entry.name);
        await DB.add('agents', { username, name: entry.name, phone: entry.phone, notes: null, office_id: null, agent_kind: 'broker' }, { username });
        window.dispatchEvent(new CustomEvent('agents:changed'));
      } else {
        await OwnersModule.addAccount(username, _addModalKind, { name: entry.name, phone: entry.phone });
      }
    } catch (err) {
      if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      return;
    }
  }

  document.getElementById('ownerAddModal')?.classList.add('hidden');
  await loadOwners();
}



function _updateTotalBalance() {
  let total = 0;
  document.querySelectorAll('#ownersTableBody tr, #brokersTableBody tr').forEach(tr => {
    if (tr.style.display === 'none') return;
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 3) {
      const val = parseFloat(cells[2]?.textContent) || 0;
      total += val;
    }
  });
  const el = document.getElementById('totalBalanceDisplay');
  if (el) el.textContent = Money.fmt(total);
}

function _printEntities(mode) {
  // Collect rows to print
  let rows = [];
  const ownerRows = document.querySelectorAll('#ownersTableBody tr');
  const brokerRows = document.querySelectorAll('#brokersTableBody tr');

  const collectFromNodeList = (nodeList, groupName) => {
    nodeList.forEach(tr => {
      if (tr.style.display === 'none') return; // skip filtered

      const cells = tr.querySelectorAll('td');
      if (cells.length < 4) return;
      // Get name from cell[0]
      const name = (cells[0]?.textContent || '').trim();
      const phone = (cells[1]?.textContent || '').trim();
      const balance = (cells[2]?.textContent || '').trim();
      rows.push({ name, phone, balance, group: groupName });
    });
  };

  collectFromNodeList(ownerRows, 'أصحاب المركبات');
  collectFromNodeList(brokerRows, 'الوسطاء');

  if (rows.length === 0) {
    alert('لا توجد بيانات للطباعة');
    return;
  }

  const tableRows = rows.map(r => `
    <tr>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:right;">${r.name}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${r.phone}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;font-weight:700;">${r.balance}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>طباعة كشف حساب العملاء</title>
  <style>
    @import url('cairo-font.css');
    body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    h2 { text-align: center; color: #1f2937; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a8a; color: #fff; padding: 10px 12px; text-align: center; border: 1px solid #1e3a8a; font-size: 0.875rem; }
    td { font-size: 0.875rem; }
    @page { size: A4 portrait; margin: 15mm; }
  </style>
</head>
<body>
  <h2>${mode === 'selected' ? 'طباعة المحدد' : 'كشف حساب العملاء'}</h2>
  <table>
    <thead><tr><th>الاسم</th><th>رقم الهاتف</th><th>الرصيد</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  printHTML(html, { id: 'entities-print-iframe' });
}

function _sortByPriority(list) {
  return list.slice().sort((a, b) => {
    // 1. Negative balance first
    const aNeg = (a.balance || 0) < 0 ? 1 : 0;
    const bNeg = (b.balance || 0) < 0 ? 1 : 0;
    if (aNeg !== bNeg) return bNeg - aNeg;
    // 2. Then by last activity (entity update OR financial transaction)
    const aTime = a.last_activity || a.updated_at || 0;
    const bTime = b.last_activity || b.updated_at || 0;
    return bTime - aTime;
  });
}

async function _getUnpaidKartaCount(clientId) {
  const allReceipts = await DB.getAll('receipts');
  let count = 0;
  for (const r of allReceipts) {
    if (r.deleted_at !== null) continue;
    if (String(r.client_id) !== String(clientId)) continue;
    if (String(r.payout_status || 'unpaid') !== 'unpaid') continue;
    const rows = Array.isArray(r.rows) ? r.rows : [];
    count += rows.filter(row => row._type !== 'separator').length;
  }
  return count;
}

function _buildClientRow(client, kartaCount, kind) {
  const accentColor = kind === 'broker' ? '#7c3aed' : '#2563eb';
  return `
    <tr data-client-name="${(client.name || '').toLowerCase()}">
      <td data-action="view-client" data-id="${client.id}" data-type="${client.type || 'owner'}" class="ent-name-cell ent-name-cell--${kind === 'broker' ? 'purple' : 'blue'}">
        ${client.name}
      </td>
      <td>${client.phone || '—'}</td>
      <td class="${_balanceClass(client.balance)}">${_fmt(client.balance)}</td>
      <td class="text-center">${kartaCount > 0 ? '<span class="ent-karta-badge">' + kartaCount + '</span>' : '—'}</td>
      <td>
        <button type="button" data-action="edit-account" data-id="${client.id}" data-kind="${kind}" class="ent-action-btn ent-action-btn--edit" title="تعديل">✏️</button>
        <button type="button" data-action="delete-account" data-id="${client.id}" data-kind="${kind}" class="ent-action-btn ent-action-btn--delete" title="حذف">🗑️</button>
      </td>
    </tr>`;
}

async function loadOwners() {
  _renderShell();

  if (_activeAccountTab === 'mandoubs') {
    const tbody = document.getElementById('customersTable');
    if (!tbody) return;
    const mandoubs = await OwnersModule.getAllMandoubs();
    const snaps = await Promise.all(mandoubs.map(a => OwnersModule.getMandoubSnapshot(String(a.id))));
    if (snaps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center p-6">لا توجد بيانات</td></tr>';
      return;
    }
    tbody.innerHTML = snaps.map(s => `
      <tr>
        <td>
<span data-action="view-mandoub" data-id="${String(s.agent.id)}" style="cursor:pointer;color:#0f766e;font-weight:700;display:block;width:100%;" onmouseover="this.parentElement.style.background='#f0fdfa'" onmouseout="this.parentElement.style.background=''">${s.agent.name || '-'}</span>
        </td>
        <td>${s.agent.phone || '—'}</td>
        <td class="${_balanceClass(s.balance)}">${_fmt(s.balance)}</td>
        <td>
          <button type="button" data-action="edit-account" data-id="${String(s.agent.id)}" data-kind="mandoub" class="ent-action-btn ent-action-btn--edit" title="تعديل">✏️</button>
          <button type="button" data-action="delete-account" data-id="${String(s.agent.id)}" data-kind="mandoub" class="ent-action-btn ent-action-btn--delete" title="حذف">🗑️</button>
        </td>
      </tr>
    `).join('');
    return;
  }

  // ── Customers tab: owners + brokers ──
  const ownersTbody = document.getElementById('ownersTableBody');
  const brokersTbody = document.getElementById('brokersTableBody');
  if (!ownersTbody || !brokersTbody) return;

  // Owners
  const owners = await DB.getAll('vehicleOwners');
  const ownerList = owners.filter(o => o.deleted_at === null && o.name).map(o => ({
    id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null
  }));
  const ownerSnaps = await Promise.all(ownerList.map(_clientSnapshot));
  const ownerKartas = await Promise.all(ownerList.map(o => _getUnpaidKartaCount(o.id)));

  const sortedOwners = _sortByPriority(ownerSnaps);
  if (sortedOwners.length === 0) {
    ownersTbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center p-6">لا توجد أصحاب مركبات</td></tr>';
  } else {
    ownersTbody.innerHTML = sortedOwners.map((client) => {
      const idx = ownerSnaps.indexOf(client);
      return _buildClientRow(client, ownerKartas[idx], 'owner');
    }).join('');
  }

  // Brokers (from agents store, agent_kind = 'broker' or null, NOT mandoub)
  const allAgents = await DB.getAll('agents');
  const username = _currentUsername();
  const brokerAgents = allAgents.filter(a =>
    a.deleted_at === null
    && a.agent_kind !== 'mandoub'
    && a.name
    && (typeof a.username === 'string' ? a.username.trim() : (typeof a.created_by === 'string' ? a.created_by.trim() : '')) === username
  );
  const brokerList = brokerAgents.map(a => ({
    id: String(a.id), type: 'broker', name: a.name || '', phone: a.phone || null
  }));
  const brokerSnaps = await Promise.all(brokerList.map(_clientSnapshot));
  const brokerKartas = await Promise.all(brokerList.map(b => _getUnpaidKartaCount(b.id)));

  const sortedBrokers = _sortByPriority(brokerSnaps);
  if (sortedBrokers.length === 0) {
    brokersTbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center p-6">لا توجد وسطاء</td></tr>';
  } else {
    brokersTbody.innerHTML = sortedBrokers.map((client) => {
      const idx = brokerSnaps.indexOf(client);
      return _buildClientRow(client, brokerKartas[idx], 'broker');
    }).join('');
  }

  // Update total balance
  _updateTotalBalance();

  // Search handler
  const searchInput = document.getElementById('ownerSearchInput');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', function() {
      const query = this.value.trim().toLowerCase();
      document.querySelectorAll('#ownersTableBody tr, #brokersTableBody tr').forEach(tr => {
        const name = tr.dataset.clientName || '';
        tr.style.display = (!query || name.includes(query)) ? '' : 'none';
      });
      _updateTotalBalance();
    });
  }
}

async function showMandoubDetails(agentId) {
  const snap = await OwnersModule.getMandoubSnapshot(String(agentId));
  const page = document.getElementById('agentDetailsPage');
  if (!page) return;

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'agentDetailsPage',
    mandoubId: String(agentId),
  }));

  const entries = snap.ledger;
  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <button type="button" data-action="back-to-accounts" class="ent-btn-back">← رجوع</button>
        <h2 class="ent-details-name">${snap.agent.name || '-'}</h2>
        <span class="ent-details-type">مندوب</span>
      </div>

      <div class="stat-grid mb-8">
        <div class="card">
          <p class="text-muted text-xs mb-1 mb-2">الرصيد الحالي</p>
          <p class="text-3xl font-bold ${_balanceClass(snap.balance)} mb-6">${_fmt(snap.balance)}</p>
          <div class="flex gap-2 flex-wrap justify-end">
            <button type="button" data-action="open-mandoub-balance-modal" data-entry-type="deposit" data-id="${String(snap.agent.id)}"
              class="btn btn-success btn-sm">
              إيداع
            </button>
            <button type="button" data-action="open-mandoub-balance-modal" data-entry-type="withdraw" data-id="${String(snap.agent.id)}"
              class="btn btn-danger btn-sm">
              سحب
            </button>
          </div>
        </div>
      </div>

      <div class="filter-row mb-6 flex-wrap">
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="mandoubFromDate">من</label>
          <input id="mandoubFromDate" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="mandoubToDate">إلى</label>
          <input id="mandoubToDate" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="mandoub-apply-filter" data-id="${String(snap.agent.id)}" class="btn btn-primary btn-sm mb-4">
          تطبيق
        </button>
        <button type="button" data-action="mandoub-clear-filter" data-id="${String(snap.agent.id)}" class="btn btn-secondary btn-sm mb-4">
          مسح التحديد
        </button>
      </div>

      <div class="table-wrapper mb-6">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>النوع</th>
              <th>المبلغ</th>
              <th>مرجع</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="mandoubLedgerBody">
            ${
              entries.length ? entries.map(e => `
                <tr>
                  <td>${_dateLabel(e.date || e.applied_at)}</td>
                  <td>${e.type === 'withdraw' ? 'سحب' : 'إيداع'}</td>
                  <td class="font-semibold">${Money.fmtCents(e.amount)}</td>
                  <td>${e.reference_id || '-'}</td>
                  <td>${e.note || '-'}</td>
                </tr>
              `).join('') : `
                <tr><td colspan="5" class="text-muted text-center">لا توجد حركات</td></tr>
              `
            }
          </tbody>
        </table>
      </div>

      <div id="mandoubBalanceModal" class="modal-overlay hidden">
        <div class="modal">
          <div class="modal-body">
            <div class="flex items-center justify-between mb-6">
              <button type="button" data-action="close-mandoub-balance-modal" class="btn btn-secondary btn-sm">إغلاق</button>
              <h3 id="mandoubBalanceTitle" class="text-lg font-bold mb-0">إيداع</h3>
            </div>
            <div class="grid gap-4">
              <div class="form-group mb-0">
                <label class="label mb-2" for="mandoubBalanceDate">التاريخ</label>
                <input id="mandoubBalanceDate" type="date" class="input input-sm">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="mandoubBalanceAmount">المبلغ</label>
                <input id="mandoubBalanceAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="mandoubBalanceNote">ملاحظة</label>
                <input id="mandoubBalanceNote" type="text" class="input input-sm" placeholder="اختياري">
              </div>
              <div id="mandoubBalanceMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
              <button type="button" data-action="save-mandoub-balance" class="btn btn-primary btn-full mt-4">
                حفظ الحركة
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (typeof window.showPage === 'function') {
    await window.showPage('agentDetailsPage');
  }
}

async function _getClient(type, id) {
  return OwnersModule.getClientByType(type, id);
}

async function _renderLedger(client) {
  const ledger = await OwnersModule.getClientLedger(client.id);
  return `
    <section class="mb-8">
      <h3 class="text-lg font-bold mb-4">الحركات</h3>
      <div class="filter-row mb-6 flex-wrap">
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientFromDate">من</label>
          <input id="clientFromDate" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientToDate">إلى</label>
          <input id="clientToDate" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="client-apply-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-primary btn-sm mb-4">
          تطبيق
        </button>
        <button type="button" data-action="client-clear-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-secondary btn-sm mb-4">
          مسح التحديد
        </button>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>المبلغ</th>
              <th>المركبة</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="clientLedgerBody">
            ${ledger.length ? ledger.map(e => `
              <tr>
                <td>${_dateLabel(e.date || e.applied_at)}</td>
                <td class="font-semibold">${_fmt(e.amount)}</td>
                <td>${e.vehicle_plate || '-'}</td>
                <td>${_ledgerNote(e)}</td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="4" class="text-muted text-center">لا توجد حركات</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}


function _ensureVehicleModal() {
  if (document.getElementById('vehicleModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="vehicleModalTitle">إضافة مركبة</h3>
          <button type="button" data-action="vehicle-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div class="grid gap-3 mb-4">
          <div>
            <label class="label mb-1" for="vehicleModalPlate">رقم المركبة</label>
            <input id="vehicleModalPlate" type="text" class="input input-sm" placeholder="أدخل رقم المركبة">
          </div>
          <div>
            <label class="label mb-1" for="vehicleModalDriver">اسم السائق</label>
            <input id="vehicleModalDriver" type="text" class="input input-sm" placeholder="اسم السائق (اختياري)">
          </div>
        </div>
        <div class="flex gap-2">
          <button type="button" data-action="vehicle-modal-save" class="btn btn-primary btn-sm btn-full">حفظ</button>
        </div>
        <div id="vehicleModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

let _vehicleEditId = null;
let _vehicleOwnerId = null;

function _openVehicleModal(title, plate, driver, ownerId, editId) {
  _ensureVehicleModal();
  _vehicleOwnerId = ownerId || null;
  _vehicleEditId = editId || null;
  const modal = document.getElementById('vehicleModal');
  const titleEl = document.getElementById('vehicleModalTitle');
  const plateEl = document.getElementById('vehicleModalPlate');
  const driverEl = document.getElementById('vehicleModalDriver');
  const msg = document.getElementById('vehicleModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (plateEl) plateEl.value = plate || '';
  if (driverEl) driverEl.value = driver || '';
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _renderOwnerVehicles(client) {
  const owned = await OwnersModule.getOwnerVehicles(client.id);

  return `
    <section>
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold mb-0">المركبات والسائقين</h3>
        <div class="flex gap-2">
          <button type="button" data-action="add-vehicle-manual" data-owner-id="${client.id}" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة مركبة</button>
        </div>
      </div>
      <div class="table-wrapper mb-10">
        <table class="table">
          <thead>
            <tr>
              <th>رقم المركبة</th>
              <th>اسم السائق</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${owned.length ? owned.map(v => `
              <tr>
                <td>${v.plate || '-'}</td>
                <td>${v.driver_name || '—'}</td>
                <td>
                  <button type="button" data-action="edit-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
                  <button type="button" data-action="delete-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
                </td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="3" class="text-muted text-center">لا توجد مركبات</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function _renderAgentReceipts(client) {
  const related = await OwnersModule.getAgentReceipts(client.id);

  return `
    <section>
      <h3 class="text-lg font-bold mb-4">النماذج المرتبطة</h3>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>رقم النموذج</th>
              <th>الإجمالي</th>
              <th>المدفوع</th>
            </tr>
          </thead>
          <tbody>
            ${related.length ? related.map(r => `
              <tr>
                <td>${_dateLabel(r.receipt_date)}</td>
                <td>${r.receipt_number || '-'}</td>
                <td>${Money.fmtCents(r.total)}</td>
                <td>${Money.fmtCents(r.paid)}</td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="4" class="text-muted text-center">لا توجد نماذج مرتبطة</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function showOwnerDetails(id, type = 'owner') {
  const client = await _getClient(type, id);
  if (!client) return;
  _selectedClient = client;

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'ownerDetailsPage',
    ownerId: String(id),
    ownerType: type,
  }));

  const balance = await OwnersModule.getClientBalance(client.id);
  const ledgerHtml = await _renderLedger(client);
  const relatedHtml = await _renderOwnerVehicles(client);

  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <button type="button" data-action="back-to-customers" class="ent-btn-back">← رجوع</button>
        <h2 class="ent-details-name">${client.name}</h2>
        <span class="ent-details-type">${client.type === 'broker' ? 'وسيط' : 'صاحب مركبة'}</span>
      </div>

      <div class="stat-grid mb-8">
        <div class="card">
          <p class="text-muted text-xs mb-2">الرصيد الحالي</p>
          <div class="text-3xl font-bold ${_balanceClass(balance.balance)} mb-6">${_fmt(balance.balance)}</div>
          <div class="flex gap-2 flex-wrap justify-end">
            <button type="button" data-action="open-balance-entry" data-entry-type="deposit"
              class="btn btn-success btn-sm">
              إيداع رصيد
            </button>
            <button type="button" data-action="open-balance-entry" data-entry-type="withdraw"
              class="btn btn-danger btn-sm">
              سحب رصيد
            </button>
          </div>
        </div>
      </div>

      ${ledgerHtml}
      ${relatedHtml}

      <div id="balanceEntryModal" class="modal-overlay hidden">
        <div class="modal">
          <div class="modal-body">
            <div class="flex items-center justify-between mb-6">
              <button type="button" data-action="close-balance-entry" class="btn btn-secondary btn-sm">إغلاق</button>
              <h3 id="balanceEntryTitle" class="text-lg font-bold mb-0">إيداع رصيد</h3>
            </div>

            <div class="grid gap-4">
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryDate">التاريخ</label>
                <input id="balanceEntryDate" type="date" class="input input-sm">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryAmount">المبلغ</label>
                <input id="balanceEntryAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryNote">ملاحظة</label>
                <input id="balanceEntryNote" type="text" class="input input-sm" placeholder="اختياري">
              </div>
              <button type="button" data-action="save-balance-entry" class="btn btn-primary btn-full mt-4">
                حفظ الحركة
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (typeof window.showPage === 'function') {
    await window.showPage('ownerDetailsPage');
  }
}

function _openBalanceEntryModal(type) {
  if (!_selectedClient) return;
  _balanceActionType = type === 'withdraw' ? 'withdraw' : 'deposit';

  const modal = document.getElementById('balanceEntryModal');
  const title = document.getElementById('balanceEntryTitle');
  const dateEl = document.getElementById('balanceEntryDate');
  const amountEl = document.getElementById('balanceEntryAmount');
  const noteEl = document.getElementById('balanceEntryNote');

  if (title) title.textContent = _balanceActionType === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد';
  if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
  if (amountEl) amountEl.value = '';
  if (noteEl) noteEl.value = '';
  modal?.classList.remove('hidden');
}

function _closeBalanceEntryModal() {
  document.getElementById('balanceEntryModal')?.classList.add('hidden');
}

async function _saveBalanceEntry() {
  if (!_selectedClient) return;

  const date = document.getElementById('balanceEntryDate')?.value;
  const amount = parseFloat(document.getElementById('balanceEntryAmount')?.value) || 0;
  const note = document.getElementById('balanceEntryNote')?.value || '';

  if (!date) {
    alert('التاريخ مطلوب');
    return;
  }
  if (amount <= 0) {
    alert('المبلغ يجب أن يكون أكبر من صفر');
    return;
  }

  await OwnersModule.createClientBalanceEntry(_currentUsername(), {
    client_id: _selectedClient.id,
    client_type: _selectedClient.type,
    client_name: _selectedClient.name,
    type: _balanceActionType,
    amount,
    date,
    note,
  });

  _closeBalanceEntryModal();
  await showOwnerDetails(_selectedClient.id, _selectedClient.type);
  await loadOwners();
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Reads all active vehicle owners + brokers and exports them to ONE Excel
 * file with the 4-column layout:
 *   | اسم صاحب المركبة | رقم الهاتف | اسم الوسيط | رقم الهاتف |
 *
 * Brokers are scoped to the current session user (same filter used by
 * loadOwners()), so the export mirrors exactly what the user sees on the
 * page. Owners are global (not username-scoped) — same as the UI.
 */
async function _handleExportOwnersExcel() {
  try {
    const username = _currentUsername();

    // Owners — active only, name required.
    const allOwners = await DB.getAll('vehicleOwners');
    const owners = allOwners
      .filter(o => o.deleted_at === null && o.name)
      .map(o => ({
        name:  String(o.name  || '').trim(),
        phone: String(o.phone || '').trim(),
      }))
      .filter(o => o.name);

    // Brokers — agents store, agent_kind !== 'mandoub', owned by this user.
    // Mirrors the filter used inside loadOwners() so the export matches the UI.
    const allAgents = await DB.getAll('agents');
    const brokers = allAgents
      .filter(a =>
        a.deleted_at === null
        && a.agent_kind !== 'mandoub'
        && a.name
        && _isAgentOwnedBy(a, username)
      )
      .map(a => ({
        name:  String(a.name  || '').trim(),
        phone: String(a.phone || '').trim(),
      }))
      .filter(b => b.name);

    if (owners.length === 0 && brokers.length === 0) {
      alert('لا توجد أسماء للتصدير.');
      return;
    }

    ExcelService.exportEntitiesExcel({ owners, brokers });
  } catch (err) {
    console.error('[entities] Excel export entities failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

/**
 * Adds a broker (agent with agent_kind='broker') to the DB.
 * Mirrors the duplicate-check logic used by the "Add Broker" modal in
 * _saveAddedNames() to keep behavior consistent across entry paths.
 *
 * Returns:
 *   'added'        — broker was inserted
 *   'skipped-dup'  — a non-mandoub agent with the same name already exists
 *
 * Throws on unexpected DB errors.
 */
async function _addBrokerFromImport(username, name, phone) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return 'skipped-dup';

  const allAgents = await DB.getAll('agents');
  const exists = allAgents.some(a =>
    a.deleted_at === null
    && a.agent_kind !== 'mandoub'
    && String(a.name || '').trim().toLowerCase() === trimmedName.toLowerCase()
  );
  if (exists) return 'skipped-dup';

  await DB.add('agents', {
    username,
    name: trimmedName,
    phone: (String(phone || '').trim() || null),
    notes: null,
    office_id: null,
    agent_kind: 'broker',
  }, { username });

  return 'added';
}

/**
 * Opens a file picker, parses owners + brokers from the combined Excel
 * file, then writes each list into its own store. Duplicates (case-
 * insensitive trimmed-name match) are silently skipped per spec — phone
 * mismatches do NOT overwrite existing records.
 */
function _handleImportOwnersExcel() {
  ExcelService.openFilePicker(async (file) => {
    try {
      const username = _currentUsername();
      const { owners, brokers } = await ExcelService.importEntitiesExcel(file);

      let ownersAdded = 0, ownersSkipped = 0;
      let brokersAdded = 0, brokersSkipped = 0;
      const errors = [];

      // ── Owners → vehicleOwners store ──────────────────────────────────
      for (const { name, phone } of owners) {
        try {
          await createOwner(username, { name, phone });
          ownersAdded++;
        } catch (err) {
          // createOwner throws when the name already exists — skip silently
          // per spec (do NOT overwrite existing phone/data).
          if (String(err.message || '').includes('مستخدم بالفعل')) {
            ownersSkipped++;
          } else {
            errors.push(`صاحب مركبة "${name}": ${err.message}`);
          }
        }
      }

      // ── Brokers → agents store (agent_kind='broker') ─────────────────
      for (const { name, phone } of brokers) {
        try {
          const result = await _addBrokerFromImport(username, name, phone);
          if (result === 'added')        brokersAdded++;
          else if (result === 'skipped-dup') brokersSkipped++;
        } catch (err) {
          errors.push(`وسيط "${name}": ${err.message}`);
        }
      }

      // Single refresh + single dispatch per affected store.
      await loadOwners();
      if (ownersAdded  > 0) window.dispatchEvent(new CustomEvent('owners:changed'));
      if (brokersAdded > 0) window.dispatchEvent(new CustomEvent('agents:changed'));

      const parts = [];
      if (ownersAdded   > 0) parts.push(`✅ تم إضافة ${ownersAdded} صاحب مركبة`);
      if (ownersSkipped > 0) parts.push(`⏭️ تم تخطي ${ownersSkipped} صاحب مركبة موجود مسبقاً`);
      if (brokersAdded  > 0) parts.push(`✅ تم إضافة ${brokersAdded} وسيط`);
      if (brokersSkipped > 0) parts.push(`⏭️ تم تخطي ${brokersSkipped} وسيط موجود مسبقاً`);
      if (errors.length > 0) parts.push(`❌ أخطاء: ${errors.join('، ')}`);

      alert(parts.join('\n') || 'لم يتم إضافة أي اسم.');
    } catch (err) {
      console.error('[entities] Excel import entities failed:', err);
      alert(err.message || '❌ فشل استيراد Excel');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function attachOwnersPageListeners() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }

  if (document.body.dataset.customerStatementBound) return;
  document.body.dataset.customerStatementBound = '1';

  document.addEventListener('click', async (e) => {
    // ── Dropdown toggle ──
    if (e.target.closest('[data-action="toggle-add-dropdown"]')) {
      const dd = document.getElementById('addNameDropdown');
      if (dd) dd.classList.toggle('hidden');
      return;
    }
    // Close dropdown on outside click
    if (!e.target.closest('#addNameDropdownWrap')) {
      const dd = document.getElementById('addNameDropdown');
      if (dd && !dd.classList.contains('hidden')) dd.classList.add('hidden');
    }

    // ── Add owner/broker type selection ──
    const addTypeBtn = e.target.closest('[data-action="add-owner-type"]');
    if (addTypeBtn) {
      document.getElementById('addNameDropdown')?.classList.add('hidden');
      const kind = addTypeBtn.dataset.kind;
      _openAddModal(kind === 'broker' ? 'وسيط' : 'صاحب مركبة', kind);
      return;
    }

    // ── Add mandoub button ──
    if (e.target.closest('[data-action="add-mandoub-btn"]')) {
      _openAddModal('مندوب', 'mandoub');
      return;
    }

    // ── Add modal: close, add-row, remove-row, save ──
    if (e.target.closest('[data-action="close-add-modal"]')) {
      document.getElementById('ownerAddModal')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="add-modal-add-row"]')) {
      document.getElementById('addModalRows')?.insertAdjacentHTML('beforeend',
        '<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>');
      return;
    }
    if (e.target.closest('[data-action="add-modal-remove-row"]')) {
      const tr = e.target.closest('tr');
      const tbody = document.getElementById('addModalRows');
      if (tbody && tbody.querySelectorAll('tr').length > 1) tr?.remove();
      return;
    }
    if (e.target.closest('[data-action="save-add-modal"]')) {
      await _saveFromAddModal();
      return;
    }



    // ── Print all ──
    if (e.target.closest('[data-action="print-owners"]')) {
      _printEntities('all');
      return;
    }

    // ── Export owners to Excel ──
    if (e.target.closest('[data-action="export-owners-excel"]')) {
      await _handleExportOwnersExcel();
      return;
    }

    // ── Import owners from Excel ──
    if (e.target.closest('[data-action="import-owners-excel"]')) {
      _handleImportOwnersExcel();
      return;
    }



    const tab = e.target.closest('[data-account-tab]');
    if (tab) {
      _activeAccountTab = tab.dataset.accountTab;
      await loadOwners();
      return;
    }

    const viewBtn = e.target.closest('[data-action="view-client"]');
    if (viewBtn) {
      await showOwnerDetails(viewBtn.dataset.id, viewBtn.dataset.type);
      return;
    }

    const mandoubBtn = e.target.closest('[data-action="view-mandoub"]');
    if (mandoubBtn) {
      await showMandoubDetails(mandoubBtn.dataset.id);
      return;
    }

    const editAccBtn = e.target.closest('[data-action="edit-account"]');
    if (editAccBtn) {
      const id = editAccBtn.dataset.id;
      const kind = editAccBtn.dataset.kind;
      // Get current data
      let currentName = '', currentPhone = '';
      if (kind === 'owner') {
        const owner = await OwnersModule.getOwnerById(id);
        currentName = owner?.name || '';
        currentPhone = owner?.phone || '';
      } else {
        const key = Number.isNaN(Number(id)) ? id : Number(id);
        const agent = await DB.getById('agents', key);
        currentName = agent?.name || '';
        currentPhone = agent?.phone || '';
      }
      _openEditModal(id, kind, currentName, currentPhone);
      return;
    }

    const delAccBtn = e.target.closest('[data-action="delete-account"]');
    if (delAccBtn) {
      if (!confirm('هل تريد حذف هذا الحساب؟')) return;
      const id = delAccBtn.dataset.id;
      const kind = delAccBtn.dataset.kind;
      try {
        if (kind === 'owner') {
          await OwnersModule.deleteOwner(_currentUsername(), id);
        } else {
          await DB.delete('agents', Number.isNaN(Number(id)) ? id : Number(id), { username: _currentUsername() });
          window.dispatchEvent(new CustomEvent('agents:changed'));
        }
        await loadOwners();
      } catch (err) { alert(err.message); }
      return;
    }

    const balanceBtn = e.target.closest('[data-action="open-balance-entry"]');
    if (balanceBtn) {
      _openBalanceEntryModal(balanceBtn.dataset.entryType);
      return;
    }

    if (e.target.closest('[data-action="close-balance-entry"]')) {
      _closeBalanceEntryModal();
      return;
    }

    if (e.target.closest('[data-action="save-balance-entry"]')) {
      try {
        await _saveBalanceEntry();
      } catch (err) {
        alert(err.message || 'حدث خطأ أثناء حفظ حركة الرصيد');
      }
      return;
    }

    // ── Vehicle management ──
    const addVehicleBtn = e.target.closest('[data-action="add-vehicle-manual"]');
    if (addVehicleBtn) {
      _openVehicleModal('إضافة مركبة', '', '', addVehicleBtn.dataset.ownerId, null);
      return;
    }

    const editVehicleBtn = e.target.closest('[data-action="edit-vehicle"]');
    if (editVehicleBtn) {
      const vehicleId = editVehicleBtn.dataset.vehicleId;
      const vehicle = await DB.getById('vehicles', vehicleId);
      if (!vehicle) return;
      _openVehicleModal('تعديل مركبة', vehicle.plate || '', vehicle.driver_name || '', vehicle.owner_id, vehicleId);
      return;
    }

    if (e.target.closest('[data-action="vehicle-modal-close"]')) {
      document.getElementById('vehicleModal')?.classList.add('hidden');
      _vehicleEditId = null;
      _vehicleOwnerId = null;
      return;
    }

    if (e.target.closest('[data-action="vehicle-modal-save"]')) {
      const plate = (document.getElementById('vehicleModalPlate')?.value || '').trim();
      const driverName = (document.getElementById('vehicleModalDriver')?.value || '').trim();
      const msg = document.getElementById('vehicleModalMsg');
      if (!plate) {
        if (msg) { msg.textContent = '❌ رقم المركبة مطلوب'; msg.classList.add('is-visible'); }
        return;
      }
      try {
        if (_vehicleEditId) {
          // Edit existing
          const patch = { plate };
          patch.driver_name = driverName || null;
          await DB.update('vehicles', _vehicleEditId, patch, { username: _currentUsername() });
        } else {
          // Add new
          const owner = _vehicleOwnerId ? await OwnersModule.getOwnerById(_vehicleOwnerId) : null;
          if (!owner) { if (msg) { msg.textContent = '❌ صاحب المركبة غير موجود'; msg.classList.add('is-visible'); } return; }
          await VehiclesModule.resolveVehicle(_currentUsername(), plate, owner);
          if (driverName) {
            const vehicles = await DB.findByFields('vehicles', { plate });
            if (vehicles[0]) {
              await DB.update('vehicles', vehicles[0].id, { driver_name: driverName }, { username: _currentUsername() });
            }
          }
        }
        document.getElementById('vehicleModal')?.classList.add('hidden');
        _vehicleEditId = null;
        _vehicleOwnerId = null;
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, _selectedClient.type);
      } catch (err) {
        if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      }
      return;
    }

    const deleteVehicleBtn = e.target.closest('[data-action="delete-vehicle"]');
    if (deleteVehicleBtn) {
      if (!confirm('هل تريد حذف هذه المركبة؟')) return;
      try {
        await DB.delete('vehicles', deleteVehicleBtn.dataset.vehicleId, { username: _currentUsername() });
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, _selectedClient.type);
      } catch (err) { alert(err.message); }
      return;
    }

    if (e.target.closest('[data-action="back-to-customers"]')) {
      if (typeof window.showPage === 'function') {
        await window.showPage('ownersPage');
      }
    }

    if (e.target.closest('[data-action="back-to-accounts"]')) {
      if (typeof window.showPage === 'function') {
        await window.showPage('ownersPage');
      }
    }

    const filterBtn = e.target.closest('[data-action="mandoub-apply-filter"]');
    if (filterBtn) {
      const agentId = filterBtn.dataset.id;
      const from = document.getElementById('mandoubFromDate')?.value || '';
      const to = document.getElementById('mandoubToDate')?.value || '';
      const snap = await OwnersModule.getMandoubSnapshot(String(agentId));
      const body = document.getElementById('mandoubLedgerBody');
      if (!body) return;
      const filtered = snap.ledger.filter(e => {
        const d = String(e.date || '').trim();
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      body.innerHTML = filtered.length ? filtered.map(e => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e.date || e.applied_at)}</td>
          <td class="p-2 text-right">${e.type === 'withdraw' ? 'سحب' : 'إيداع'}</td>
          <td class="p-2 text-right font-semibold">${Money.fmtCents(e.amount)}</td>
          <td class="p-2 text-right">${e.reference_id || '-'}</td>
          <td class="p-2 text-right">${e.note || '-'}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }

    const mandoubClearBtn = e.target.closest('[data-action="mandoub-clear-filter"]');
    if (mandoubClearBtn) {
      const fromEl = document.getElementById('mandoubFromDate');
      const toEl = document.getElementById('mandoubToDate');
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      const agentId = mandoubClearBtn.dataset.id;
      const snap = await OwnersModule.getMandoubSnapshot(String(agentId));
      const body = document.getElementById('mandoubLedgerBody');
      if (!body) return;
      body.innerHTML = snap.ledger.length ? snap.ledger.map(e => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e.date || e.applied_at)}</td>
          <td class="p-2 text-right">${e.type === 'withdraw' ? 'سحب' : 'إيداع'}</td>
          <td class="p-2 text-right font-semibold">${Money.fmtCents(e.amount)}</td>
          <td class="p-2 text-right">${e.reference_id || '-'}</td>
          <td class="p-2 text-right">${e.note || '-'}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }

    const clientFilterBtn = e.target.closest('[data-action="client-apply-filter"]');
    if (clientFilterBtn) {
      const id = clientFilterBtn.dataset.id;
      const from = document.getElementById('clientFromDate')?.value || '';
      const to = document.getElementById('clientToDate')?.value || '';
      const body = document.getElementById('clientLedgerBody');
      if (!body) return;
      const ledger = await OwnersModule.getClientLedger(String(id));
      const filtered = ledger.filter(e1 => {
        const d = _dateLabel(e1.date || e1.applied_at);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      body.innerHTML = filtered.length ? filtered.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${e1.vehicle_plate || '-'}</td>
          <td class="p-2 text-right">${_ledgerNote(e1)}</td>
        </tr>
      `).join('') : `<tr><td colspan="4" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }

    const clientClearBtn = e.target.closest('[data-action="client-clear-filter"]');
    if (clientClearBtn) {
      const fromEl = document.getElementById('clientFromDate');
      const toEl = document.getElementById('clientToDate');
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      const id = clientClearBtn.dataset.id;
      const body = document.getElementById('clientLedgerBody');
      if (!body) return;
      const ledger = await OwnersModule.getClientLedger(String(id));
      body.innerHTML = ledger.length ? ledger.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${e1.vehicle_plate || '-'}</td>
          <td class="p-2 text-right">${_ledgerNote(e1)}</td>
        </tr>
      `).join('') : `<tr><td colspan="4" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }

    const openMandoubModal = e.target.closest('[data-action="open-mandoub-balance-modal"]');
    if (openMandoubModal) {
      const modal = document.getElementById('mandoubBalanceModal');
      const title = document.getElementById('mandoubBalanceTitle');
      const dateEl = document.getElementById('mandoubBalanceDate');
      const amountEl = document.getElementById('mandoubBalanceAmount');
      const noteEl = document.getElementById('mandoubBalanceNote');
      const msgEl = document.getElementById('mandoubBalanceMsg');
      if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('is-visible'); }
      const entryType = openMandoubModal.dataset.entryType === 'withdraw' ? 'withdraw' : 'deposit';
      if (modal) {
        modal.dataset.entryType = entryType;
        modal.dataset.agentId = openMandoubModal.dataset.id;
      }
      if (title) title.textContent = entryType === 'withdraw' ? 'سحب' : 'إيداع';
      if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];
      if (amountEl) amountEl.value = '';
      if (noteEl) noteEl.value = '';
      modal?.classList.remove('hidden');
      return;
    }

    if (e.target.closest('[data-action="close-mandoub-balance-modal"]')) {
      document.getElementById('mandoubBalanceModal')?.classList.add('hidden');
      return;
    }

    if (e.target.closest('[data-action="save-mandoub-balance"]')) {
      const modal = document.getElementById('mandoubBalanceModal');
      const msgEl = document.getElementById('mandoubBalanceMsg');
      const agentId = modal?.dataset.agentId || '';
      const entryType = modal?.dataset.entryType || 'deposit';
      const date = document.getElementById('mandoubBalanceDate')?.value || '';
      const amount = parseFloat(document.getElementById('mandoubBalanceAmount')?.value) || 0;
      const note = document.getElementById('mandoubBalanceNote')?.value || '';
      if (!date) { if (msgEl) { msgEl.textContent = '❌ التاريخ مطلوب'; msgEl.classList.add('is-visible'); } return; }
      if (amount <= 0) { if (msgEl) { msgEl.textContent = '❌ المبلغ يجب أن يكون أكبر من صفر'; msgEl.classList.add('is-visible'); } return; }
      try {
        await OwnersModule.adjustMandoubBalance(_currentUsername(), String(agentId), entryType, amount, date, note);
        modal?.classList.add('hidden');
        await showMandoubDetails(agentId);
      } catch (err) {
        if (msgEl) { msgEl.textContent = err.message || '❌ حدث خطأ أثناء حفظ الحركة'; msgEl.classList.add('is-visible'); }
      }
      return;
    }
  });
}

window.addEventListener('owners:changed', () => {
  // Only refresh details if details page is currently visible
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner');
  }
  loadOwners();
});

window.addEventListener('agents:changed', () => {
  loadOwners();
});

window.showOwnerDetails = showOwnerDetails;
window.showMandoubDetails = showMandoubDetails;


// ========================================
// Public API
// ========================================

export {
  AgentsService,
  VehiclesModule,
  resolveVehicle,
  OwnersModule,
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getOwnerBalance,
  getOwnerLedger,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  getAgentReceipts,
  addAccount,
  getMandoubSnapshot,
  getAllMandoubs,
  adjustMandoubBalance,
  loadOwners,
  attachOwnersPageListeners,
  showOwnerDetails,
};
