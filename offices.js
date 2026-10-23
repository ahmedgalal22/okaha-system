/**
 * offices.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { DB } from './database.js';
import { FinancialService } from './financial.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';


// ========================================
// Services — OfficesService
// ========================================

const STORE = 'offices';
const RECEIPTS_STORE = 'receipts';
const BOLSA_STORE = 'bolsaForms';

const _hamolaCache = new Map();

function _cacheKey(username, officeId) {
  return `${username}::${officeId}`;
}

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('[OfficesService] crypto.randomUUID is required');
}

function _requireUsername(username, ctx) {
  if (!username) throw new Error(`[OfficesService:${ctx}] username is required.`);
  return username;
}

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _requireText(value, label) {
  const text = _toText(value).trim();
  if (!text) throw new Error(`[OfficesService] ${label} is required.`);
  return text;
}

function _optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function _requireNumber(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`[OfficesService] ${label} is required.`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`[OfficesService] ${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`[OfficesService] ${label} must be a number.`);
  }
  return n;
}

function _normalizeHamolaRow(input, keepId = false) {
  if (!input || typeof input !== 'object') {
    throw new Error('[OfficesService] hamola row must be a plain object.');
  }

  const loading_place = _requireText(
    input.loading_place ?? input.loading,
    'loading_place'
  );
  const destination_place = _requireText(
    input.destination_place ?? input.direction ?? input.taktik,
    'destination_place'
  );
  const nolon = _requireNumber(input.nolon ?? input.noloon, 'nolon');
  const office_amount = Number(input.office_amount ?? input.maktab ?? 0) || 0;
  const item_type = _optionalText(input.item_type ?? input.type) || null;
  const price = Number(input.price ?? 0) || 0;

  return {
    id: keepId && input.id ? String(input.id) : _uuid(),
    loading_place,
    destination_place,
    nolon,
    office_amount,
    item_type,
    price,
  };
}

function _applyHamolaPatch(existing, patch) {
  const next = { ...existing };

  if ('loading_place' in patch || 'loading' in patch) {
    next.loading_place = _requireText(
      patch.loading_place ?? patch.loading,
      'loading_place'
    );
  }
  if ('destination_place' in patch || 'direction' in patch || 'taktik' in patch) {
    next.destination_place = _requireText(
      patch.destination_place ?? patch.direction ?? patch.taktik,
      'destination_place'
    );
  }
  if ('price' in patch) {
    next.price = Number(patch.price ?? 0) || 0;
  }
  if ('nolon' in patch || 'noloon' in patch) {
    next.nolon = _requireNumber(patch.nolon ?? patch.noloon, 'nolon');
  }
  if ('office_amount' in patch || 'maktab' in patch) {
    next.office_amount = Number(patch.office_amount ?? patch.maktab ?? 0) || 0;
  }
  if ('item_type' in patch || 'type' in patch) {
    next.item_type = _optionalText(patch.item_type ?? patch.type) || null;
  }

  return next;
}

function _normalizeOffice(office) {
  const hamolaRows = Array.isArray(office?.hamolaRows)
    ? office.hamolaRows.map((row) => _normalizeHamolaRow(row, true))
    : [];

  return {
    ...office,
    hamolaRows,
  };
}

function _cacheHamola(username, officeId, rows) {
  if (!username || !officeId) return;
  _hamolaCache.set(_cacheKey(username, officeId), rows);
}

function _getCachedHamola(username, officeId) {
  return _hamolaCache.get(_cacheKey(username, officeId)) || null;
}

async function createOffices(username, rows) {
  _requireUsername(username, 'createOffices');
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('[OfficesService] rows must be a non-empty array.');
  }

  const existing = await DB.findByFields(STORE, { username });
  const existingNames = new Set(
    existing.map((o) => String(o.name || '').trim().toLowerCase()).filter(Boolean)
  );

  const seen = new Set();
  const payloads = rows.map((row) => {
    if (!row || typeof row !== 'object') {
      throw new Error('[OfficesService] office row must be a plain object.');
    }

    const name = _requireText(row.name, 'name');
    const lower = name.toLowerCase();

    if (existingNames.has(lower) || seen.has(lower)) {
      throw new Error(`[OfficesService] duplicate office name: ${name}`);
    }
    seen.add(lower);

    const hamolaRows = Array.isArray(row.hamolaRows)
      ? row.hamolaRows.map((r) => _normalizeHamolaRow(r, false))
      : [];

    return {
      id: _uuid(),
      username,
      name,
      phone: _optionalText(row.phone),
      hamolaRows,
    };
  });

  const ops = payloads.map((payload) => ({
    op: 'add',
    store: STORE,
    payload,
  }));

  const saved = await DB.transaction(ops, { username });
  saved.forEach((record) => _cacheHamola(username, record.id, record.hamolaRows || []));

  window.dispatchEvent(new CustomEvent('offices:changed'));
  return saved;
}

async function updateOffice(username, id, patch) {
  _requireUsername(username, 'updateOffice');
  if (!id) throw new Error('[OfficesService:updateOffice] id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  const office = await getOfficeById(id, username);

  if ('name' in patch) {
    const name = _requireText(patch.name, 'name');
    const existing = await DB.findByFields(STORE, { username });
    const dup = existing.some((o) => String(o.id) !== String(id)
      && String(o.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`[OfficesService] duplicate office name: ${name}`);
  }

  const nextPatch = {
    ...(patch.name !== undefined ? { name: _requireText(patch.name, 'name') } : {}),
    ...(patch.phone !== undefined ? { phone: _optionalText(patch.phone) } : {}),
  };

  const updated = await DB.update(STORE, String(id), nextPatch, { username });
  _cacheHamola(username, updated.id, updated.hamolaRows || office.hamolaRows || []);
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function deleteOffice(username, id) {
  _requireUsername(username, 'deleteOffice');
  if (!id) throw new Error('[OfficesService:deleteOffice] id is required.');
  const office = await getOfficeById(id, username);
  if (!office) throw new Error('[OfficesService] office not found.');
  const deleted = await DB.delete(STORE, String(id), { username });
  _hamolaCache.delete(_cacheKey(username, id));
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return deleted;
}

async function getOffices(username) {
  _requireUsername(username, 'getOffices');
  const offices = await DB.findByFields(STORE, { username });
  const normalized = offices.map(_normalizeOffice);
  normalized.forEach((o) => _cacheHamola(username, o.id, o.hamolaRows || []));
  return normalized;
}

async function getOfficeById(id, username) {
  _requireUsername(username, 'getOfficeById');
  if (!id) throw new Error('[OfficesService:getOfficeById] id is required.');
  const office = await DB.getById(STORE, String(id));
  if (!office || office.deleted_at !== null) return null;
  if (office.username !== username) {
    throw new Error('[OfficesService] cross-user access is forbidden.');
  }
  const normalized = _normalizeOffice(office);
  _cacheHamola(username, normalized.id, normalized.hamolaRows || []);
  return normalized;
}

async function addHamolaRow(username, office_id, row) {
  _requireUsername(username, 'addHamolaRow');
  if (!office_id) throw new Error('[OfficesService:addHamolaRow] office_id is required.');
  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const nextRow = _normalizeHamolaRow(row, false);
  const hamolaRows = [...(office.hamolaRows || []), nextRow];

  const updated = await DB.update(STORE, String(office_id), { hamolaRows }, { username });
  _cacheHamola(username, updated.id, hamolaRows);
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function updateHamolaRow(username, office_id, row_id, patch) {
  _requireUsername(username, 'updateHamolaRow');
  if (!office_id) throw new Error('[OfficesService:updateHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:updateHamolaRow] row_id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const rows = office.hamolaRows || [];
  const idx = rows.findIndex((r) => String(r.id) === String(row_id));
  if (idx === -1) throw new Error('[OfficesService] hamola row not found.');

  const updatedRow = _applyHamolaPatch(rows[idx], patch);
  const nextRows = rows.slice();
  nextRows[idx] = updatedRow;

  const updated = await DB.update(STORE, String(office_id), { hamolaRows: nextRows }, { username });
  _cacheHamola(username, updated.id, nextRows);
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function deleteHamolaRow(username, office_id, row_id) {
  _requireUsername(username, 'deleteHamolaRow');
  if (!office_id) throw new Error('[OfficesService:deleteHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:deleteHamolaRow] row_id is required.');

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const rows = office.hamolaRows || [];
  const nextRows = rows.filter((r) => String(r.id) !== String(row_id));
  if (nextRows.length === rows.length) {
    throw new Error('[OfficesService] hamola row not found.');
  }

  const updated = await DB.update(STORE, String(office_id), { hamolaRows: nextRows }, { username });
  _cacheHamola(username, updated.id, nextRows);
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

function _calcWeight(row) {
  const w1 = Number(row.weight) || 0;
  const w2 = Number(row.weight2) || 0;
  const d = Number(row.deficit) || 0;
  return (w1 + w2) - d;
}

function _calcReceiptNet(row) {
  const w1 = Number(row.weight) || 0;
  const w2 = Number(row.weight2) || 0;
  const d = Number(row.deficit) || 0;
  const n = Number(row.noloon) || 0;
  const ohda = Number(row.ohda) || 0;
  const officeAmount = Number(row.officeAmount) || 0;
  const discount = Number(row.discount) || 0;
  const add = Number(row.add) || 0;
  return ((w1 + w2) - d) * n - (ohda + officeAmount + discount) + add;
}

function _calcBolsaNet(row) {
  const total = Number(row.total_price ?? row.total);
  if (Number.isFinite(total)) return total;
  const w = (Number(row.weight) || 0) + (Number(row.weight2) || 0);
  const price = Number(row.price) || 0;
  return price * w;
}

function _resolveRange(filters) {
  if (!filters || typeof filters !== 'object') return null;

  const now = new Date();
  if (filters.range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'week') {
    const day = now.getDay();
    const diff = now.getDate() - day;
    const start = new Date(now.getFullYear(), now.getMonth(), diff).getTime();
    const end = start + 7 * 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
    return { from: start, to: end };
  }

  const from = filters.from ? new Date(filters.from).getTime() : null;
  const to = filters.to ? new Date(filters.to).getTime() : null;
  if ((filters.from && Number.isNaN(from)) || (filters.to && Number.isNaN(to))) {
    throw new Error('[OfficesService] invalid date range.');
  }
  if (from == null && to == null) return null;

  return {
    from: from ?? 0,
    to: to ?? Date.now(),
  };
}

async function getOfficeFinancialSummary(username, filters = null) {
  _requireUsername(username, 'getOfficeFinancialSummary');

  const offices = await getOffices(username);
  const nameMap = new Map(
    offices.map((o) => [String(o.name || '').trim().toLowerCase(), o])
  );

  const summary = new Map();
  for (const office of offices) {
    summary.set(String(office.id), {
      office,
      net: 0,
      weight: 0,
      balance: 0,
    });
  }

  const range = _resolveRange(filters);
  const useBolsa = Boolean(range);

  if (useBolsa) {
    const forms = await DB.findByFields(BOLSA_STORE, { username });
    const filtered = range
      ? forms.filter((f) => {
          const t = new Date(f.bolsa_date || 0).getTime();
          return t >= range.from && t <= range.to;
        })
      : forms;

    for (const form of filtered) {
      const rows = Array.isArray(form.rows) ? form.rows : [];
      for (const row of rows) {
        const officeName = String(row.office || '').trim();
        if (!officeName) continue;
        const office = nameMap.get(officeName.toLowerCase());
        if (!office) {
          throw new Error(`[OfficesService] unknown office: ${officeName}`);
        }
        const item = summary.get(String(office.id));
        item.weight += (Number(row.weight) || 0) + (Number(row.weight2) || 0);
        item.net += _calcBolsaNet(row);
      }
    }
  } else {
    const receipts = await DB.findByFields(RECEIPTS_STORE, { username });
    for (const receipt of receipts) {
      const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
      for (const row of rows) {
        if (row?._type === 'separator') continue;
        const officeName = String(row.office || '').trim();
        if (!officeName) continue;
        const office = nameMap.get(officeName.toLowerCase());
        if (!office) {
          throw new Error(`[OfficesService] unknown office: ${officeName}`);
        }
        const item = summary.get(String(office.id));
        item.weight += _calcWeight(row);
        item.net += _calcReceiptNet(row);
      }
    }
  }

  const rows = Array.from(summary.values());
  const balances = await Promise.all(
    rows.map((item) => FinancialService.getClientBalance(item.office.id))
  );
  rows.forEach((item, idx) => {
    const snap = balances[idx];
    if (!snap) {
      throw new Error('[OfficesService] balance lookup failed.');
    }
    item.balance = snap.balance;
  });

  const totals = rows.reduce(
    (acc, item) => {
      acc.total_net += item.net;
      acc.total_weight += item.weight;
      return acc;
    },
    { total_net: 0, total_weight: 0 }
  );

  return {
    total_offices: rows.length,
    total_net: totals.total_net,
    total_weight: totals.total_weight,
    rows,
  };
}

async function getOfficeLedger(username, office_id) {
  _requireUsername(username, 'getOfficeLedger');
  if (!office_id) throw new Error('[OfficesService:getOfficeLedger] office_id is required.');
  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');
  const ledger = await FinancialService.getClientLedger(String(office_id));

  const receiptIds = [...new Set(
    ledger
      .filter((e) => e.reference_type === 'receipt' && e.reference_id)
      .map((e) => String(e.reference_id))
  )];

  const receiptMap = new Map();
  for (const id of receiptIds) {
    const receipt = await DB.getById(RECEIPTS_STORE, id);
    if (receipt && receipt.receipt_number) {
      receiptMap.set(id, String(receipt.receipt_number));
    }
  }

  return ledger.map((entry) => ({
    ...entry,
    reference_number: receiptMap.get(String(entry.reference_id)) || null,
  }));
}

async function depositToOffice(username, office_id, payload) {
  _requireUsername(username, 'depositToOffice');
  if (!office_id) throw new Error('[OfficesService:depositToOffice] office_id is required.');
  if (!payload || typeof payload !== 'object') {
    throw new Error('[OfficesService] payload must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const data = {
    ...payload,
    office_id: String(office.id),
  };

  return FinancialService.createOfficeDeposit(username, data);
}

async function adjustOfficeBalance(username, office_id, payload) {
  _requireUsername(username, 'adjustOfficeBalance');
  if (!office_id) throw new Error('[OfficesService:adjustOfficeBalance] office_id is required.');
  if (!payload || typeof payload !== 'object') {
    throw new Error('[OfficesService] payload must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  if (payload.type === 'deposit') {
    return FinancialService.createOfficeDeposit(username, {
      office_id: String(office.id),
      amount: payload.amount,
      note: payload.note,
      date: payload.date,
    });
  }

  const data = {
    ...payload,
    client_id: String(office.id),
    client_type: 'office',
    client_name: office.name || '',
  };

  return FinancialService.createClientBalanceEntry(username, data);
}

const OfficesService = Object.freeze({
  createOffices,
  updateOffice,
  deleteOffice,
  getOffices,
  getOfficeById,
  addHamolaRow,
  updateHamolaRow,
  deleteHamolaRow,
  getOfficeFinancialSummary,
  getOfficeLedger,
  depositToOffice,
  adjustOfficeBalance,
  _getCachedHamola,
});



// ========================================
// Module — OfficesModule
// ========================================

function _moduleSessionUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

const OfficesModule = Object.freeze({
  getOffices: () => OfficesService.getOffices(_moduleSessionUsername()),
  createOffices: (rows) => OfficesService.createOffices(_moduleSessionUsername(), rows),
  updateOffice: (id, patch) => OfficesService.updateOffice(_moduleSessionUsername(), id, patch),
  deleteOffice: (id) => OfficesService.deleteOffice(_moduleSessionUsername(), id),
  getOfficeDetails: (id) => OfficesService.getOfficeById(id, _moduleSessionUsername()),
  getOfficeLedger: (office_id) => OfficesService.getOfficeLedger(_moduleSessionUsername(), office_id),
  adjustOfficeBalance: (office_id, payload) =>
    OfficesService.adjustOfficeBalance(_moduleSessionUsername(), office_id, payload),
  depositToOffice: (office_id, payload) =>
    OfficesService.depositToOffice(_moduleSessionUsername(), office_id, payload),
  addHamolaRow: (office_id, row) =>
    OfficesService.addHamolaRow(_moduleSessionUsername(), office_id, row),
  updateHamolaRow: (office_id, row_id, patch) =>
    OfficesService.updateHamolaRow(_moduleSessionUsername(), office_id, row_id, patch),
  deleteHamolaRow: (office_id, row_id) =>
    OfficesService.deleteHamolaRow(_moduleSessionUsername(), office_id, row_id),
  getOfficeSummary: (filters = null) =>
    OfficesService.getOfficeFinancialSummary(_moduleSessionUsername(), filters),
});



// ========================================
// Offices Page — Rendering / Events
// ========================================

let _searchQuery = '';
let _editingOfficeId = null;
let _editingOfficeDraft = null;
let _activeDetailsTab = 'balance';
let _detailsOfficeId = null;
let _hamolaEditId = null;
let _isOfficeDepositSaving = false;
const _officeBolsaActionInFlight = new Set();
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';

function _requireSession() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

function _fmt(n) {
  return Money.fmt(n);
}

function _balanceClass(value) {
  return Number(value) < 0 ? 'balance-negative' : 'balance-positive';
}

function _text(value) {
  return value == null ? '' : String(value);
}

function _escHtml(value) {
  return _text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderListShell() {
  const page = document.getElementById('officesPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- العنوان والأزرار -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h2 class="text-2xl font-bold text-gray-800 mb-0">إدارة العملاء</h2>
        <div class="flex gap-2">
          <button type="button" data-action="office-add" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:10px;padding:8px 18px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit;transition:box-shadow 0.2s;">➕ إضافة عميل</button>
        </div>
      </div>

      <!-- بطاقات الملخص -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <div style="background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">عدد العملاء</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalCount">0</p>
        </div>
        <div style="background:linear-gradient(135deg,#10b981,#059669);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي الوزن</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalWeight">0.00</p>
        </div>
        <div style="background:linear-gradient(135deg,#f97316,#ea580c);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي الرصيد</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalBalance">0.00</p>
        </div>
      </div>

      <!-- شريط البحث -->
      <div class="mb-6">
        <input id="officeSearch" type="text" class="input" placeholder="🔍 ابحث عن عميل..." style="border-radius:12px;padding:10px 16px 10px 40px;" />
      </div>

      <!-- قائمة الشركات -->
      <div style="margin-bottom:8px;">
        <h3 class="text-lg font-bold text-gray-800 mb-3">قائمة العملاء</h3>
      </div>
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
            <tr>
              <th style="color:#fff;">اسم العميل</th>
              <th style="color:#fff;">رقم الهاتف</th>
              <th style="color:#fff;">إجمالي الوزن</th>
              <th style="color:#fff;">الرصيد</th>
              <th style="color:#fff;">إجراءات</th>
            </tr>
          </thead>
          <tbody id="officesTableBody"></tbody>
        </table>
      </div>

      <div id="officesInlineMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
    </div>
  `;

  if (!document.getElementById('officeModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderOfficeModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderOfficeModal() {
  return `
    <div id="officeModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-3xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">إضافة عملاء</h3>
          <button type="button" data-action="office-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="table-wrapper overflow-x-auto mb-4">
          <table class="table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>الهاتف</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody id="officeModalBody"></tbody>
          </table>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="office-modal-add-row" class="btn btn-secondary btn-sm">➕ إضافة صف</button>
          <button type="button" data-action="office-modal-save" class="btn btn-primary btn-sm">حفظ الكل</button>
        </div>
        <div id="officeModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeModalRow() {
  return `
    <tr>
      <td><input type="text" class="input input-sm office-modal-name" placeholder="اسم العميل" /></td>
      <td><input type="text" class="input input-sm office-modal-phone" placeholder="الهاتف" /></td>
      <td><button type="button" data-action="office-modal-remove-row" class="btn btn-secondary btn-sm">حذف</button></td>
    </tr>
  `;
}

function _renderDetailsShell(office) {
  const page = document.getElementById('officeDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- رأس التفاصيل -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div class="flex items-center gap-3">
          <button type="button" data-action="office-back" style="background:#6b7280;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">← العودة</button>
          <div>
            <h2 class="text-xl font-bold text-gray-800 mb-0">${office.name}</h2>
            <p class="text-muted text-xs mb-0">عرض وإدارة البيانات الكاملة</p>
          </div>
        </div>
        <button type="button" data-action="office-print" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">🖨️ طباعة</button>
      </div>

      <!-- بيانات الشركة -->
      <div style="background:linear-gradient(135deg,#f0fdf4,#f0fdfa);border-radius:12px;padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:20px;">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">🏢</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">اسم العميل</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.name}</p>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#0f766e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">📞</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">رقم الهاتف</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.phone || '—'}</p>
          </div>
        </div>
      </div>

      <!-- التبويبات -->
      <div style="display:flex;border-bottom:2px solid #e5e7eb;margin-bottom:20px;" role="tablist">
        <button type="button" data-tab="cards" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'cards' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'cards' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'cards' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'cards' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">📋 الكارتات</button>
        <button type="button" data-tab="balance" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'balance' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'balance' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'balance' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'balance' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">💰 رصيد العميل</button>
        <button type="button" data-tab="hamola" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'hamola' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'hamola' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'hamola' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'hamola' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">🚚 تفاصيل الحمولة</button>
      </div>

      <div id="officeDetailsContent"></div>
    </div>
  `;

  if (!document.getElementById('hamolaModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderHamolaModal();
    document.body.appendChild(modal.firstElementChild);
  }

  if (!document.getElementById('officeDepositModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderOfficeDepositModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderHamolaModal() {
  return `
    <div id="hamolaModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="hamolaModalTitle">إضافة حمولة</h3>
          <button type="button" data-action="hamola-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label class="label mb-1" for="hamolaLoading">مكان التحميل</label>
            <input id="hamolaLoading" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaDestination">الجهة</label>
            <input id="hamolaDestination" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaNolon">النولون</label>
            <input id="hamolaNolon" type="number" step="0.01" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaMaktab">المكتب</label>
            <input id="hamolaMaktab" type="number" step="0.01" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaType">النوع</label>
            <input id="hamolaType" type="text" class="input input-sm" />
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="hamola-modal-save" class="btn btn-primary btn-sm">حفظ</button>
        </div>
        <div id="hamolaModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeDepositModal() {
  return `
    <div id="officeDepositModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">إيداع رصيد</h3>
          <button type="button" data-action="office-deposit-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="grid grid-cols-1 gap-3 mb-4">
          <div>
            <label class="label mb-1" for="officeDepositAmount">المبلغ</label>
            <input id="officeDepositAmount" type="number" step="0.01" min="0" class="input input-sm" />
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="office-deposit-save" class="btn btn-primary btn-sm">حفظ</button>
        </div>
        <div id="officeDepositMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeBalance(entries) {
  function entryDate(entry) {
    return entry.date || entry.applied_at || entry.created_at || '';
  }

  function entryTypeLabel(entry) {
    if (entry.type === 'OFFICE_DEPOSIT' || entry.type === 'deposit') return 'إيداع';
    if (entry.type === 'OFFICE_WITHDRAW_AUTO' || entry.type === 'withdraw') return 'سحب';
    return _text(entry.type || '');
  }

  function entryDelta(entry) {
    const amount = Number(entry.amount) || 0;
    if (entry.type === 'OFFICE_DEPOSIT' || entry.type === 'OFFICE_WITHDRAW_AUTO') return amount;
    if (entry.type === 'deposit') return Math.abs(amount);
    if (entry.type === 'withdraw') return -Math.abs(amount);
    return amount;
  }

  const sorted = entries.slice().sort((a, b) => {
    const da = new Date(entryDate(a) || 0).getTime();
    const db = new Date(entryDate(b) || 0).getTime();
    return da - db;
  });

  let running = 0;
  const withBalance = sorted.map((entry) => {
    const delta = entryDelta(entry);
    running += delta;
    return { entry, delta, balance: running };
  });

  const currentBalance = withBalance.length
    ? withBalance[withBalance.length - 1].balance
    : 0;
  const currentClass = _balanceClass(currentBalance);

  const displayRows = withBalance.slice().reverse();
  const rows = displayRows.length
    ? displayRows.map(({ entry, delta, balance }) => `
      <tr>
        <td>${_text(entryDate(entry))}</td>
        <td>${entryTypeLabel(entry)}</td>
        <td>${delta < 0 ? '-' : ''}${_fmt(Math.abs(delta))}</td>
        <td>${_fmt(balance)}</td>
        <td>${_text(entry.type === 'OFFICE_DEPOSIT' ? (entry.note || entry.reference_number || entry.reference_id || '-') : (entry.reference_number || entry.reference_id || '-'))}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="5" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;

  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <div>
        <p class="text-muted text-xs mb-1">الرصيد الحالي</p>
        <p class="text-2xl font-bold ${currentClass}">${_fmt(currentBalance)}</p>
      </div>
      <div class="flex gap-2">
        <button type="button" data-action="office-deposit-open" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">💰 إيداع رصيد</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
          <tr>
            <th style="color:#fff;">التاريخ</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">المبلغ</th>
            <th style="color:#fff;">الرصيد بعد العملية</th>
            <th style="color:#fff;">المرجع</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}


/**
 * Compute total weight per (loading_place, destination_place) from saved receipts.
 * Returns map: { "loading__destination": totalWeight }
 */
async function _computeWeightMap(office) {
  const username = _moduleSessionUsername();
  const officeName = String(office.name || '').trim().toLowerCase();
  const receipts = await DB.findByFields('receipts', { username });
  const weightMap = {};

  for (const receipt of receipts) {
    if (receipt.deleted_at !== null) continue;
    const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (const row of rows) {
      if (row._type === 'separator') continue;
      const rowOffice = String(row.office || '').trim().toLowerCase();
      if (rowOffice !== officeName) continue;

      const loading = String(row.loading || '').trim().toLowerCase();
      const dest = String(row.taktik || row.direction || '').trim().toLowerCase();
      const w = (Number(row.weight) || 0) + (Number(row.weight2) || 0);
      if (!loading || !dest) continue;

      const key = loading + '__' + dest;
      weightMap[key] = (weightMap[key] || 0) + w;
    }
  }

  return weightMap;
}

function _renderHamolaTable(rows, weightMap = {}) {
  const body = rows.length
    ? rows.map((r) => {
        const key = String(r.loading_place || '').trim().toLowerCase() + '__' + String(r.destination_place || '').trim().toLowerCase();
        const weight = weightMap[key] || 0;
        return `
      <tr>
        <td>${_text(r.loading_place)}</td>
        <td>${_text(r.destination_place)}</td>
        <td>${_fmt(weight)}</td>
        <td>${_fmt(r.nolon)}</td>
        <td>
          <button type="button" data-action="hamola-edit" data-id="${r.id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
          <button type="button" data-action="hamola-delete" data-id="${r.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
        </td>
      </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="text-center text-muted p-6" style="color:#94a3b8;">لا توجد بيانات — اضغط إضافة حمولة</td></tr>`;

  return `
    <div class="flex justify-between items-center flex-wrap gap-3 mb-4">
      <h3 class="text-xl font-bold text-gray-800">قائمة أماكن التحميل والتعتيق</h3>
      <div class="flex items-center gap-3 flex-wrap">
        <button type="button" data-action="hamola-add" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة حمولة</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#16a34a,#15803d);">
          <tr>
            <th style="color:#fff;">التحميل</th>
            <th style="color:#fff;">الجهة</th>
            <th style="color:#fff;">الوزن</th>
            <th style="color:#fff;">النولون</th>
            <th style="color:#fff;">إجراءات</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function loadOffices() {
  const session = _requireSession();
  if (!session) return;

  _renderListShell();

  const searchEl = document.getElementById('officeSearch');
  if (searchEl) searchEl.value = _searchQuery || '';

  const summary = await OfficesModule.getOfficeSummary();
  const totalCountEl = document.getElementById('officeTotalCount');
  const totalWeightEl = document.getElementById('officeTotalWeight');

  if (totalCountEl) totalCountEl.textContent = String(summary.total_offices || 0);
  const totalBalanceEl = document.getElementById("officeTotalBalance");
  if (totalBalanceEl) totalBalanceEl.textContent = _fmt(summary.rows.reduce((s, r) => s + (r.balance || 0), 0));
  if (totalWeightEl) totalWeightEl.textContent = _fmt(summary.total_weight);

  const tbody = document.getElementById('officesTableBody');
  if (!tbody) return;

  const query = _searchQuery.trim().toLowerCase();
  const rows = summary.rows.filter((item) => {
    if (!query) return true;
    const name = String(item.office.name || '').toLowerCase();
    const phone = String(item.office.phone || '').toLowerCase();
    return name.includes(query) || phone.includes(query);
  });

  tbody.innerHTML = rows.map((item) => {
    const office = item.office;
    const isEditing = _editingOfficeId && String(_editingOfficeId) === String(office.id);
    const nameVal = isEditing ? _editingOfficeDraft?.name ?? office.name : office.name;
    const phoneVal = isEditing ? _editingOfficeDraft?.phone ?? office.phone : office.phone;

    return `
      <tr data-id="${office.id}" style="transition:background 0.15s;">
        <td ${!isEditing ? `data-action="office-details" data-id="${office.id}" style="cursor:pointer;color:#2563eb;font-weight:700;" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''"` : ''}>
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-name" value="${_text(nameVal)}" />`
            : _text(office.name)
          }
        </td>
        <td style="color:#374151;">
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-phone" value="${_text(phoneVal)}" />`
            : _text(office.phone || '—')
          }
        </td>
        <td style="color:#374151;">${_fmt(item.weight)}</td>
        <td class="${Number(item.balance) < 0 ? 'balance-negative' : ''}" style="font-weight:700;">${_fmt(item.balance)}</td>
        <td>
          ${isEditing
            ? `
              <button type="button" data-action="office-save" data-id="${office.id}" class="btn btn-primary btn-sm">حفظ</button>
              <button type="button" data-action="office-cancel" class="btn btn-secondary btn-sm">إلغاء</button>
            `
            : `
              <button type="button" data-action="office-details" data-id="${office.id}" class="btn-icon" title="تفاصيل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">📋</button>
              <button type="button" data-action="office-delete" data-id="${office.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
            `
          }
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="5" class="text-center text-muted p-6">
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px;">
      <div style="width:64px;height:64px;background:#e2e8f0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;">🏢</div>
      <p style="font-weight:700;color:#64748b;margin:0;">لا يوجد عملاء</p>
      <p style="font-size:0.8125rem;color:#94a3b8;margin:0;">ابدأ بإضافة العملاء من الزر أعلاه</p>
    </div>
  </td></tr>`;
}

async function showOfficeDetails(id) {
  const session = _requireSession();
  if (!session) return;
  if (!id) throw new Error('[offices-page] office id is required');

  _detailsOfficeId = String(id);
  const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
  if (!office) throw new Error('Office not found');

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'officeDetailsPage',
    officeId: _detailsOfficeId,
  }));

  _renderDetailsShell(office);
  await _renderDetailsContent(office);

  if (typeof window.showPage === 'function') {
    await window.showPage('officeDetailsPage');
  }
}


function _bolsaRowMatchesOffice(row, officeId, officeName) {
  if (!row) return false;

  const hasOfficeId = Object.prototype.hasOwnProperty.call(row, 'office_id');
  return hasOfficeId
    ? row.office_id != null && String(row.office_id) === officeId
    : String(row.office || '').trim().toLowerCase() === officeName;
}

function _bolsaRowBelongsToOtherOffice(row, officeId, officeName) {
  if (!row) return false;

  const hasOfficeId = Object.prototype.hasOwnProperty.call(row, 'office_id');
  if (hasOfficeId) {
    return row.office_id != null && String(row.office_id) !== officeId;
  }

  const legacyOfficeName = String(row.office || '').trim().toLowerCase();
  return Boolean(legacyOfficeName && legacyOfficeName !== officeName);
}

function _optionalFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function _getBolsaRowPricing(row) {
  const weight = _optionalFiniteNumber(row?.weight) ?? 0;
  const price = _optionalFiniteNumber(row?.price);

  if (price === null) {
    return { weight, price: null, totalPrice: null };
  }

  const storedTotalPrice = _optionalFiniteNumber(row?.total_price);
  const totalPrice = storedTotalPrice === null
    ? Money.round(weight * price)
    : Money.round(storedTotalPrice);

  return { weight, price, totalPrice };
}

function _buildOfficeBolsaFormCard(form, officeId, officeName) {
  if (!form || form.id === null || form.id === undefined) return null;

  const rows = Array.isArray(form.rows) ? form.rows : [];
  const displayedRows = [];
  let isShared = false;
  let weightCents = 0;
  let totalPriceCents = 0;
  let hasMissingTotalPrice = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    if (_bolsaRowBelongsToOtherOffice(row, officeId, officeName)) {
      isShared = true;
    }

    if (!_bolsaRowMatchesOffice(row, officeId, officeName)) continue;

    const pricing = _getBolsaRowPricing(row);
    displayedRows.push({
      source: 'bolsa',
      bolsa_form_id: String(form.id),
      source_row_id: row._rowId ? String(row._rowId) : `${form.id}:${i}`,
      row_index: i,
      date: row.rowdate || '',
      driver: row.driver || '',
      car: row.carNo || '',
      weight: pricing.weight,
      loading: row.loading || '',
      taktik: row.direction || '',
      type: row.type || '',
      price: pricing.price,
      total_price: pricing.totalPrice,
    });

    weightCents += Money.toCents(pricing.weight);
    if (pricing.totalPrice === null) {
      hasMissingTotalPrice = true;
    } else {
      totalPriceCents += Money.toCents(pricing.totalPrice);
    }
  }

  if (displayedRows.length === 0) return null;

  return {
    id: String(form.id),
    bolsa_date: form.bolsa_date || '',
    rows: displayedRows,
    is_shared: isShared,
    totals: {
      row_count: displayedRows.length,
      weight: Money.toDecimal(weightCents),
      total_price: hasMissingTotalPrice ? null : Money.toDecimal(totalPriceCents),
    },
  };
}

async function _getOfficeBolsaFormCards(office) {
  const username = _moduleSessionUsername();
  const officeId = String(office.id);
  const officeName = String(office.name || '').trim().toLowerCase();
  const forms = await DB.findByFields(BOLSA_STORE, { username });

  forms.sort((a, b) => {
    const byBolsaDate = new Date(b.bolsa_date || 0).getTime() - new Date(a.bolsa_date || 0).getTime();
    if (byBolsaDate !== 0) return byBolsaDate;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  const cards = [];
  for (const form of forms) {
    if (form.deleted_at !== null) continue;
    const card = _buildOfficeBolsaFormCard(form, officeId, officeName);
    if (card) cards.push(card);
  }

  return cards;
}

function _renderOfficeBolsaFormCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '';

  const headers = [
    'التاريخ',
    'اسم السائق',
    'رقم المركبة',
    'الوزن',
    'التحميل',
    'الجهة',
    'النوع',
    'السعر',
    'السعر الكلي',
  ].map((label) => `<th>${label}</th>`).join('');

  const cardHtml = cards.map((card) => {
    const tableRows = card.rows.map((row) => `
      <tr data-source="bolsa" data-bolsa-form-id="${_escHtml(card.id)}" data-source-row-id="${_escHtml(row.source_row_id)}">
        <td>${_escHtml(row.date)}</td>
        <td>${_escHtml(row.driver)}</td>
        <td>${_escHtml(row.car)}</td>
        <td>${_fmt(row.weight)}</td>
        <td>${_escHtml(row.loading)}</td>
        <td>${_escHtml(row.taktik)}</td>
        <td>${_escHtml(row.type)}</td>
        <td>${row.price === null ? '—' : _fmt(row.price)}</td>
        <td>${row.total_price === null ? '—' : _fmt(row.total_price)}</td>
      </tr>
    `).join('');

    return `
      <article class="record-card bolsa-record" data-kind="bolsa" data-id="${_escHtml(card.id)}">
        <header class="record-card__header">
          <div class="record-card__heading">
            <h3>نموذج تسجيل البوالص — ${_escHtml(card.bolsa_date || '—')}</h3>
            ${card.is_shared ? '<span class="record-card__meta">نموذج مشترك</span>' : ''}
          </div>
          <div class="record-card__actions no-print">
            <button type="button" data-action="edit-bolsa" data-id="${_escHtml(card.id)}">✏️ تعديل</button>
            <button type="button" data-action="print-bolsa" data-id="${_escHtml(card.id)}">🖨️ طباعة</button>
            <button type="button" data-action="delete-bolsa" data-id="${_escHtml(card.id)}">🗑️ حذف</button>
          </div>
        </header>
        <div class="record-card__table-wrap">
          <table class="record-table office-bolsa-cards-table">
            <thead><tr>${headers}</tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div class="record-card__footer">
          <div>
            <span>عدد الصفوف</span>
            <strong>${card.totals.row_count}</strong>
          </div>
          <div>
            <span>إجمالي الوزن</span>
            <strong>${_fmt(card.totals.weight)}</strong>
          </div>
          <div>
            <span>إجمالي السعر الكلي</span>
            <strong>${card.totals.total_price === null ? '—' : _fmt(card.totals.total_price)}</strong>
          </div>
        </div>
      </article>`;
  }).join('');

  return `
    <section class="office-bolsa-cards" style="margin-top:20px;">
      <h3 style="font-size:1rem;font-weight:800;color:#1f2937;margin:0 0 14px;">كارتات البوالص</h3>
      <div style="display:flex;flex-direction:column;gap:20px;">${cardHtml}</div>
    </section>`;
}

function _renderOfficeCards(bolsaFormCards = []) {
  return _renderOfficeBolsaFormCards(bolsaFormCards)
    || '<div style="text-align:center;padding:32px;color:#94a3b8;">لا توجد كارتات لهذا العميل</div>';
}

async function _refreshOfficeBolsaCards() {
  if (!_detailsOfficeId) return;
  const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
  if (office) await _renderDetailsContent(office);
}

async function _waitForBolsaAgentOption(agentId) {
  const wantedAgentId = String(agentId ?? '').trim();
  if (!wantedAgentId) {
    throw new Error('تعذر العثور على المندوب الأصلي للنموذج، لذلك لم يتم فتح التعديل.');
  }

  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    const select = document.getElementById('bolsaAgent');
    const hasAgentOption = [...(select?.options || [])]
      .some((option) => String(option.value) === wantedAgentId);
    if (hasAgentOption) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('تعذر العثور على المندوب الأصلي للنموذج، لذلك لم يتم فتح التعديل.');
}

async function _editOfficeBolsaForm(formId) {
  const username = _moduleSessionUsername();
  const form = await FinancialService.getBolsaForm(username, formId);
  if (!form) {
    await _refreshOfficeBolsaCards();
    throw new Error('لم يعد نموذج البوالص موجودًا أو تم حذفه.');
  }

  if (typeof window.showPage === 'function') {
    await window.showPage('bolsaPage');
  }

  await _waitForBolsaAgentOption(form.agent_id);
  const { loadBolsaForEdit } = await import('./bolsas.js');
  await loadBolsaForEdit(form);

  const agentEl = document.getElementById('bolsaAgent');
  if (!agentEl || String(agentEl.value) !== String(form.agent_id)) {
    throw new Error('تعذر تحديد المندوب الأصلي للنموذج عند فتح التعديل.');
  }
}

function _buildOfficeBolsaPrintBody(card, office, esc) {
  const headers = [
    'التاريخ',
    'اسم السائق',
    'رقم المركبة',
    'الوزن',
    'التحميل',
    'الجهة',
    'النوع',
    'السعر',
    'السعر الكلي',
  ].map((label) => `<th class="print-th-emerald">${esc(label)}</th>`).join('');

  const rows = card.rows.map((row) => `
    <tr>
      <td>${esc(row.date)}</td>
      <td>${esc(row.driver)}</td>
      <td>${esc(row.car)}</td>
      <td style="text-align:center;">${esc(_fmt(row.weight))}</td>
      <td>${esc(row.loading)}</td>
      <td>${esc(row.taktik)}</td>
      <td>${esc(row.type)}</td>
      <td style="text-align:center;">${row.price === null ? '—' : esc(_fmt(row.price))}</td>
      <td style="text-align:center;">${row.total_price === null ? '—' : esc(_fmt(row.total_price))}</td>
    </tr>
  `).join('');

  return `
    <div class="print-header">
      <h2>تسجيل البوالص</h2>
      <div class="print-header-info">
        <span>التاريخ: <strong>${esc(card.bolsa_date || '—')}</strong></span>
        <span>العميل: <strong>${esc(office?.name || '')}</strong></span>
      </div>
    </div>
    <table>
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="print-footer">
      <span>عدد الصفوف: <strong>${esc(String(card.totals.row_count))}</strong></span>
      <span>إجمالي الوزن: <strong>${esc(_fmt(card.totals.weight))}</strong></span>
      <span>إجمالي السعر الكلي: <strong>${card.totals.total_price === null ? '—' : esc(_fmt(card.totals.total_price))}</strong></span>
    </div>`;
}

async function _printOfficeBolsaForm(formId) {
  const username = _moduleSessionUsername();
  const office = _detailsOfficeId
    ? await OfficesModule.getOfficeDetails(_detailsOfficeId)
    : null;
  if (!office) throw new Error('تعذر العثور على العميل الحالي لطباعة النموذج.');

  const form = await FinancialService.getBolsaForm(username, formId);
  if (!form) {
    await _refreshOfficeBolsaCards();
    throw new Error('لم يعد نموذج البوالص موجودًا أو تم حذفه.');
  }

  const officeName = String(office.name || '').trim().toLowerCase();
  const card = _buildOfficeBolsaFormCard(form, String(office.id), officeName);
  if (!card) {
    await _refreshOfficeBolsaCards();
    throw new Error('لا توجد صفوف لهذا العميل في نموذج البوالص.');
  }

  const { printHTML, buildPrintDocument, _escPrint } = await import('./printEngine.js');
  const body = _buildOfficeBolsaPrintBody(card, office, _escPrint);
  printHTML(buildPrintDocument({
    title: `تسجيل البوالص — ${card.bolsa_date || ''}`,
    body,
    orientation: 'landscape',
  }), { id: 'office-bolsa-card-print-iframe' });
}

async function _deleteOfficeBolsaForm(formId) {
  const username = _moduleSessionUsername();
  const office = _detailsOfficeId
    ? await OfficesModule.getOfficeDetails(_detailsOfficeId)
    : null;
  if (!office) throw new Error('تعذر العثور على العميل الحالي لحذف النموذج.');

  const form = await FinancialService.getBolsaForm(username, formId);
  if (!form) {
    await _refreshOfficeBolsaCards();
    throw new Error('لم يعد نموذج البوالص موجودًا أو تم حذفه.');
  }

  const officeId = String(office.id);
  const officeName = String(office.name || '').trim().toLowerCase();
  const isShared = (Array.isArray(form.rows) ? form.rows : [])
    .some((row) => _bolsaRowBelongsToOtherOffice(row, officeId, officeName));

  const confirmation = isShared
    ? 'هذا نموذج مشترك. سيتم حذف نموذج تسجيل البوالص الأصلي بالكامل، بما في ذلك صفوف جميع العملاء الموجودين فيه، وسيتم تنفيذ العكس المالي الحالي المرتبط بالمبلغ على المندوب والخزنة. هل تريد المتابعة؟'
    : 'سيتم حذف نموذج تسجيل البوالص هذا بالكامل. هل تريد المتابعة؟';
  if (!confirm(confirmation)) return;

  await FinancialService.deleteBolsaForm(username, formId);
  await _refreshOfficeBolsaCards();
}

async function _renderDetailsContent(office) {
  const content = document.getElementById('officeDetailsContent');
  if (!content) return;

  if (_activeDetailsTab === 'balance') {
    const ledger = await OfficesModule.getOfficeLedger(office.id);
    content.innerHTML = _renderOfficeBalance(ledger || []);
    return;
  }

  if (_activeDetailsTab === 'hamola') {
    const weightMap = await _computeWeightMap(office);
    content.innerHTML = _renderHamolaTable(office.hamolaRows || [], weightMap);
  }

  if (_activeDetailsTab === 'cards') {
    content.innerHTML = '<div style="text-align:center;padding:24px;color:#9ca3af;">جاري التحميل...</div>';
    const bolsaCardsData = await _getOfficeBolsaFormCards(office);
    content.innerHTML = _renderOfficeCards(bolsaCardsData);
  }
}

function _openOfficeModal() {
  const modal = document.getElementById('officeModal');
  const body = document.getElementById('officeModalBody');
  const msg = document.getElementById('officeModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  if (body) body.innerHTML = _renderOfficeModalRow();
  modal?.classList.remove('hidden');
}

function _closeOfficeModal() {
  document.getElementById('officeModal')?.classList.add('hidden');
}

function _openHamolaModal(title, row = null) {
  const modal = document.getElementById('hamolaModal');
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const t = document.getElementById('hamolaModalTitle');
  if (t) t.textContent = title;

  const loading = document.getElementById('hamolaLoading');
  const destination = document.getElementById('hamolaDestination');
  const price = document.getElementById('hamolaPrice');
  const nolon = document.getElementById('hamolaNolon');

  if (loading) loading.value = row?.loading_place || '';
  if (destination) destination.value = row?.destination_place || '';
  if (nolon) nolon.value = row?.nolon ?? '';

  const maktab = document.getElementById('hamolaMaktab');
  const typeInp = document.getElementById('hamolaType');
  if (maktab) maktab.value = row?.office_amount ?? '';
  if (typeInp) typeInp.value = row?.item_type ?? '';

  modal?.classList.remove('hidden');
}

function _closeHamolaModal() {
  document.getElementById('hamolaModal')?.classList.add('hidden');
}

function _openOfficeDepositModal() {
  const modal = document.getElementById('officeDepositModal');
  const msg = document.getElementById('officeDepositMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  const amountEl = document.getElementById('officeDepositAmount');
  if (amountEl) amountEl.value = '';
  const saveBtn = document.querySelector('[data-action="office-deposit-save"]');
  if (saveBtn) saveBtn.disabled = _isOfficeDepositSaving;
  modal?.classList.remove('hidden');
}

function _closeOfficeDepositModal() {
  document.getElementById('officeDepositModal')?.classList.add('hidden');
}

async function _saveOfficeDeposit() {
  if (_isOfficeDepositSaving) return;

  const msg = document.getElementById('officeDepositMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const amountVal = parseFloat(document.getElementById('officeDepositAmount')?.value) || 0;

  if (!_detailsOfficeId) {
    if (msg) {
      msg.textContent = 'لا يوجد عميل محدد';
      msg.classList.add('is-visible');
    }
    return;
  }

  if (Money.toCents(amountVal) <= 0) {
    if (msg) {
      msg.textContent = 'المبلغ مطلوب ويجب أن يكون أكبر من صفر';
      msg.classList.add('is-visible');
    }
    return;
  }

  const saveBtn = document.querySelector('[data-action="office-deposit-save"]');
  _isOfficeDepositSaving = true;
  if (saveBtn) saveBtn.disabled = true;

  try {
    if (typeof OfficesModule.depositToOffice !== 'function') {
      throw new Error('Office deposit handler is not available');
    }

    await OfficesModule.depositToOffice(_detailsOfficeId, {
      amount: amountVal,
      note: 'إيداع مبلغ',
      date: new Date().toISOString().split('T')[0],
    });

    _closeOfficeDepositModal();
    const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
    await _renderDetailsContent(office);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'حدث خطأ أثناء الإيداع';
      msg.classList.add('is-visible');
    }
  } finally {
    _isOfficeDepositSaving = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function _saveHamolaRow() {
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const loading = document.getElementById('hamolaLoading')?.value;
  const destination = document.getElementById('hamolaDestination')?.value;
  const nolon = document.getElementById('hamolaNolon')?.value;
  const maktab = document.getElementById('hamolaMaktab')?.value;
  const itemType = document.getElementById('hamolaType')?.value;

  try {
    if (_hamolaEditId) {
      await OfficesModule.updateHamolaRow(_detailsOfficeId, _hamolaEditId, {
        loading_place: loading,
        destination_place: destination,
        nolon,
        office_amount: maktab,
        item_type: itemType,
      });
    } else {
      await OfficesModule.addHamolaRow(_detailsOfficeId, {
        loading_place: loading,
        destination_place: destination,
        nolon,
        office_amount: maktab,
        item_type: itemType,
      });
    }

    _hamolaEditId = null;
    _closeHamolaModal();
    const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
    await _renderDetailsContent(office);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
      msg.classList.add('is-visible');
    }
  }
}

function attachOfficesPageListeners() {
  if (document.body.dataset.officesBound) return;
  document.body.dataset.officesBound = '1';

  document.addEventListener('click', async (e) => {
    const target = e.target;

    if (target.closest('[data-action="office-add"]')) {
      _openOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-close"]')) {
      _closeOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-add-row"]')) {
      document.getElementById('officeModalBody')?.insertAdjacentHTML('beforeend', _renderOfficeModalRow());
      return;
    }
    if (target.closest('[data-action="office-modal-remove-row"]')) {
      target.closest('tr')?.remove();
      return;
    }
    if (target.closest('[data-action="office-modal-save"]')) {
      const rows = [...document.querySelectorAll('#officeModalBody tr')].map((tr) => ({
        name: tr.querySelector('.office-modal-name')?.value,
        phone: tr.querySelector('.office-modal-phone')?.value,
      }));
      try {
        await OfficesModule.createOffices(rows);
        _closeOfficeModal();
        await loadOffices();
      } catch (err) {
        const msg = document.getElementById('officeModalMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
          msg.classList.add('is-visible');
        }
      }
      return;
    }

    if (target.closest('[data-action="office-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      _editingOfficeId = id;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-cancel"]')) {
      _editingOfficeId = null;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-save"]')) {
      const row = target.closest('tr');
      const id = row?.dataset.id;
      const name = row?.querySelector('.office-edit-name')?.value;
      const phone = row?.querySelector('.office-edit-phone')?.value;
      try {
        await OfficesModule.updateOffice(id, { name, phone });
        _editingOfficeId = null;
        _editingOfficeDraft = null;
        await loadOffices();
      } catch (err) {
        const msg = document.getElementById('officesInlineMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء التعديل';
          msg.classList.add('is-visible');
        }
      }
      return;
    }
    if (target.closest('[data-action="office-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف العميل؟')) return;
      await OfficesModule.deleteOffice(id);
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-details"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (id) await showOfficeDetails(id);
      return;
    }

    if (target.closest('[data-action="office-back"]')) {
      _activeDetailsTab = 'balance';
      _detailsOfficeId = null;
      if (typeof window.showPage === 'function') await window.showPage('officesPage');
      return;
    }

    if (target.closest('[data-action="office-deposit-open"]')) {
      _openOfficeDepositModal();
      return;
    }

    if (target.closest('[data-action="office-deposit-close"]')) {
      _closeOfficeDepositModal();
      return;
    }

    if (target.closest('[data-action="office-deposit-save"]')) {
      await _saveOfficeDeposit();
      return;
    }

    const bolsaActionButton = target.closest(
      '[data-action="edit-bolsa"], [data-action="print-bolsa"], [data-action="delete-bolsa"]'
    );
    if (bolsaActionButton?.closest('#officeDetailsContent')) {
      const action = bolsaActionButton.dataset.action;
      const formId = String(bolsaActionButton.dataset.id || '');
      if (!formId || _officeBolsaActionInFlight.has(formId)) return;

      _officeBolsaActionInFlight.add(formId);
      bolsaActionButton.disabled = true;
      try {
        if (action === 'edit-bolsa') {
          await _editOfficeBolsaForm(formId);
        } else if (action === 'print-bolsa') {
          await _printOfficeBolsaForm(formId);
        } else if (action === 'delete-bolsa') {
          await _deleteOfficeBolsaForm(formId);
        }
      } catch (err) {
        console.error('[offices:bolsa-card]', err);
        const fallback = action === 'edit-bolsa'
          ? 'حدث خطأ أثناء فتح تعديل نموذج البوالص.'
          : action === 'print-bolsa'
            ? 'حدث خطأ أثناء طباعة نموذج البوالص.'
            : 'حدث خطأ أثناء حذف نموذج البوالص.';
        alert(err?.message || fallback);
      } finally {
        _officeBolsaActionInFlight.delete(formId);
        if (bolsaActionButton.isConnected) bolsaActionButton.disabled = false;
      }
      return;
    }

    if (target.closest('[data-action="office-print"]')) {
      if (_detailsOfficeId) {
        const content = document.getElementById('officeDetailsContent');
        if (content) {
          const { printHTML, buildPrintDocument } = await import('./printEngine.js');
          const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
          printHTML(buildPrintDocument({
            title: 'طباعة تفاصيل العميل',
            body: '<h2 style="text-align:center;color:#0f766e;margin-bottom:12px;">' + (office?.name || '') + '</h2>' + content.innerHTML,
            orientation: 'portrait',
          }), { id: 'office-print-iframe' });
        }
      }
      return;
    }

    const tabBtn = target.closest('[data-tab]');
    if (tabBtn) {
      _activeDetailsTab = tabBtn.dataset.tab;
      if (_detailsOfficeId) {
        const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
        // Re-render full shell to update tab active state
        _renderDetailsShell(office);
        await _renderDetailsContent(office);
      }
      return;
    }

    if (target.closest('[data-action="hamola-add"]')) {
      _hamolaEditId = null;
      _openHamolaModal('إضافة حمولة');
      return;
    }

    if (target.closest('[data-action="hamola-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      const row = office?.hamolaRows?.find((r) => String(r.id) === String(id));
      if (!row) return;
      _hamolaEditId = id;
      _openHamolaModal('تعديل حمولة', row);
      return;
    }

    if (target.closest('[data-action="hamola-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف الحمولة؟')) return;
      await OfficesModule.deleteHamolaRow(_detailsOfficeId, id);
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      await _renderDetailsContent(office);
      return;
    }

    if (target.closest('[data-action="hamola-modal-close"]')) {
      _hamolaEditId = null;
      _closeHamolaModal();
      return;
    }

    if (target.closest('[data-action="hamola-modal-save"]')) {
      await _saveHamolaRow();
      return;
    }
  });

  document.addEventListener('input', async (e) => {
    const target = e.target;
    if (target?.id === 'officeSearch') {
      _searchQuery = target.value || '';
      await loadOffices();
    }
  });


  window.addEventListener('offices:changed', () => {
    loadOffices();
  });

  window.addEventListener('bolsaForms:changed', async () => {
    if ((_activeDetailsTab !== 'cards' && _activeDetailsTab !== 'hamola') || !_detailsOfficeId) return;
    try {
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      if (office) await _renderDetailsContent(office);
    } catch (_) {}
  });
}


function initOfficesPage() {
  const session = _requireSession();
  if (!session) return;
  _renderListShell();
}

window.showOfficeDetails = showOfficeDetails;


// ========================================
// Public API
// ========================================

export { OfficesService, OfficesModule, initOfficesPage, loadOffices, attachOfficesPageListeners, showOfficeDetails };
