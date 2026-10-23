/**
 * financial.js — treasury, ledger, shared financial operations
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN DECISION: Pre-generated UUID for receipts
 *   receipts.id is a UUID string (not autoIncrement integer).
 *   This lets us pass reference_id to treasury + vehicle_ledger entries
 *   BEFORE any insert fires — enabling a single atomic DB.transaction()
 *   across all three stores with zero orphan-record risk.
 *
 * RULE 2  : ALL money operations live here. Zero treasury/ledger writes elsewhere.
 * RULE 3  : Every operation executes inside ONE DB.transaction() call.
 * RULE 4  : update/delete MUST reverse old entries before applying new ones.
 * RULE 5  : Every financial record carries { reference_type, reference_id }.
 * RULE 6  : All monetary values are numbers — never strings.
 * RULE 9  : DB stores integers (cents). money.js handles all conversion.
 *
 * Reversal strategy: is_reversed: true  (NOT soft-delete)
 *   Reversed entries remain fully visible in the audit trail.
 *   Soft-delete (deleted_at) is reserved for user-initiated receipt deletion only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DB } from './database.js';
import { Money } from './money.js';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const STORE = Object.freeze({
  RECEIPTS : 'receipts',
  TREASURY : 'treasury',
  LEDGER   : 'vehicle_ledger',
  OFFICES  : 'offices',
});

const REF_TYPE      = 'receipt';
const BOLSA_REF_TYPE = 'bolsa';
const ACCOUNT_TYPES = Object.freeze(['cash', 'bank', 'vodafone', 'none']);
const OFFICE_LEDGER_TYPES = Object.freeze({
  DEPOSIT       : 'OFFICE_DEPOSIT',
  WITHDRAW_AUTO : 'OFFICE_WITHDRAW_AUTO',
});

const RECEIPT_PAYOUT_STATUS = Object.freeze({
  PAID  : 'paid',
  UNPAID: 'unpaid',
});

// ─── UUID GENERATOR ────────────────────────────────────────────────────────────

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── INTERNAL HELPERS ──────────────────────────────────────────────────────────

function _normalizePayoutStatus(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === RECEIPT_PAYOUT_STATUS.PAID) return RECEIPT_PAYOUT_STATUS.PAID;
  if (v === RECEIPT_PAYOUT_STATUS.UNPAID) return RECEIPT_PAYOUT_STATUS.UNPAID;
  return null;
}

function _toKey(value) {
  return String(value || '').trim().toLowerCase();
}

function _calcBolsaTotals(rows, addition = 0) {
  const list = Array.isArray(rows) ? rows : [];
  let ohda = 0;
  let dokhan = 0;
  for (const r of list) {
    ohda   += Number(r?.ohda)   || 0;
    dokhan += Number(r?.dokhan) || 0;
  }
  const add = Money.round(Number(addition) || 0);
  const grand_total = Money.round(ohda + dokhan + add);
  return {
    ohda: Money.round(ohda),
    dokhan: Money.round(dokhan),
    addition: add,
    grand_total,
  };
}

// ─── DOMAIN EVENTS (service-owned dispatch) ────────────────────────────────────
//
// ARCHITECTURE RULE (Karta System):
//   FinancialService is the SOLE owner of domain events for bolsaForms,
//   agents, and treasury.  No caller may dispatch these events directly.
//
//   _emit():
//     - private/internal only
//     - never throws (must not break the save flow if a listener errors)
//     - called ONLY after a DB transaction has fully committed
//
//   This keeps event ownership in one place and makes the MySQL/HTTP
//   migration a single-line swap (replace window.dispatchEvent with a
//   server-side event bus / SSE / webhook).
//
function _emit(eventName) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent(eventName));
  } catch (_) {
    // Listener errors must never break a successful save.
  }
}

// ─── BOLSA INTEGRITY (shared by CREATE and UPDATE) ─────────────────────────────
//
// One pipeline for validation + normalization, used by both create and
// update paths so the integrity rules can never diverge.
//
// IndexedDB note: structured invariants that span multiple records (here:
// "karta numbers are globally unique across all bolsa forms of this user")
// cannot be enforced by IndexedDB itself because karta numbers live inside
// a nested JSON `rows` array.  We perform the cross-record scan INSIDE the
// transaction's getAll() to minimise the race window:
//
//   * Best-effort guarantee in IDB.  An IDB readwrite transaction holds
//     locks on the listed stores for the duration of the callback, so two
//     simultaneous saves serialize.  Within a single tab, this fully
//     prevents collisions.
//   * Cross-tab guarantee in IDB.  IDB readwrite txs across different
//     connections also serialize per store.  Two tabs cannot both pass
//     this check and both commit — the second one will see the first
//     one's rows when it re-reads inside its own tx.
//   * MySQL migration: replace the JS scan with a UNIQUE constraint on a
//     normalized `bolsa_rows.karta_no` column.  The check function below
//     can stay as a pre-flight UX validator (fail-fast) while the DB
//     enforces the real invariant.
//
// MIGRATION-FRIENDLY SHAPE:
//   The function is pure (no side effects), takes the transaction handle,
//   and returns nothing on success / throws on failure.  When migrating,
//   this becomes the place to add a SQL SELECT … FOR UPDATE if needed.
//

async function _assertBolsaIntegrity(tx, username, payload, opts) {
  const { rows, excludeFormId = null } = payload;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    throw new Error('❌ يجب إضافة صف واحد على الأقل');
  }

  // Step 1 — per-row required fields + intra-form karta uniqueness.
  const seen = new Set();
  for (const r of list) {
    const kartaNo = String(r?.kartaNo ?? '').trim();
    const ownerName = String(r?.owner_name ?? '').trim();
    if (!kartaNo)   throw new Error('❌ رقم الكارتة مطلوب في كل صف');
    if (!ownerName) throw new Error('❌ اسم صاحب المركبة مطلوب');
    if (seen.has(kartaNo)) {
      throw new Error(`❌ رقم الكارتة مكرر داخل نفس النموذج: ${kartaNo}`);
    }
    seen.add(kartaNo);
  }

  // Step 2 — owner whitelist (must exist + not soft-deleted).
  // TASK D (Phase 2) — scoped to current tenant via by_username index.
  // Previously read globally with tx.getAll('vehicleOwners') which let a
  // bolsa for tenant A reference an owner name that only existed in
  // tenant B.  After MySQL migration this becomes the natural FK scope.
  const allOwners = await tx.getByIndex('vehicleOwners', 'by_username', username);
  const ownerNames = new Set(
    allOwners
      .filter(o => String(o?.name || '').trim())
      .map(o => String(o.name).trim())
  );
  for (const r of list) {
    const ownerName = String(r.owner_name).trim();
    if (!ownerNames.has(ownerName)) {
      throw new Error(`❌ اسم صاحب المركبة غير موجود في قاعدة البيانات: ${ownerName}`);
    }
  }

  // Step 3 — global karta uniqueness, scoped to the current user, excluding
  // the form being edited (so re-saving an existing form is allowed).
  // Read inside the same tx → other readwrite txs on bolsaForms wait.
  const allForms = await tx.getByIndex('bolsaForms', 'by_username', username);
  for (const form of allForms) {
    if (excludeFormId && String(form.id) === String(excludeFormId)) continue;
    const formRows = Array.isArray(form?.rows) ? form.rows : [];
    for (const fr of formRows) {
      const k = String(fr?.kartaNo ?? '').trim();
      if (k && seen.has(k)) {
        throw new Error(`❌ رقم الكارتة مستخدم بالفعل في بوالص أخرى: ${k}`);
      }
    }
  }
}

// Normalize one row into the persisted shape.  Used by both create and
// update so the stored shape never drifts.  Pure function.
function _normalizeBolsaRow(r) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
  return {
    kartaNo:    str(r?.kartaNo),
    rowdate:    str(r?.rowdate),
    driver:     str(r?.driver),
    owner_name: str(r?.owner_name),
    carNo:      str(r?.carNo),
    weight:     num(r?.weight),
    weight2:    num(r?.weight2),
    office:     str(r?.office),
    loading:    str(r?.loading),
    direction:  str(r?.direction),
    type:       str(r?.type),
    ohda:       num(r?.ohda),
    dokhan:     num(r?.dokhan),
    noloon:     num(r?.noloon),
    solar:      num(r?.solar),
    notes:      str(r?.notes),
    used_in_receipt: r?.used_in_receipt === true,
    used_receipt_id: r?.used_receipt_id ?? null,
  };
}

function _requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`[FinancialService] ${label} is required.`);
  return text;
}

function _storesForOps(ops, extra = []) {
  return [...new Set([
    ...extra,
    ...(Array.isArray(ops) ? ops.map((op) => op.store).filter(Boolean) : []),
  ])];
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────

/**
 * Validate and normalise raw input.
 * INPUT:  decimal values from UI  (e.g. total: 1500.50)
 * OUTPUT: clean object with cents (e.g. total: 150050)
 */
function _validate(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService] data must be a plain object.');
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const dataRows = rows.filter(r => r && r._type !== 'separator');
  if (dataRows.length === 0) {
    throw new Error('[FinancialService] rows must contain at least one data row.');
  }

  const client_id = data.client_id != null ? String(data.client_id).trim() : '';
  const client_type = data.client_type === 'owner'
    || data.client_type === 'office'
    ? data.client_type
    : '';
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';
  if (!client_id) {
    throw new Error('[FinancialService] client_id is required.');
  }
  if (!client_type) {
    throw new Error('[FinancialService] client_type must be owner or office.');
  }

  const clientVehicleGroups = new Map();
  for (const row of dataRows) {
    const owner_id = typeof row.owner_id === 'string' ? row.owner_id.trim() : '';
    if (!owner_id) {
      throw new Error('[FinancialService] row.owner_id must be a non-empty UUID string.');
    }
    const vehicle_id = typeof row.vehicle_id === 'string' ? row.vehicle_id.trim() : '';
    if (!vehicle_id) {
      throw new Error('[FinancialService] row.vehicle_id must be a non-empty UUID string.');
    }

    const owner_name = typeof row.owner_name === 'string' ? row.owner_name.trim() : '';
    const vehicle_plate = typeof row.vehicle_plate === 'string' ? row.vehicle_plate.trim() : '';
    const rowNet = Money.toCents(row.net ?? 0);
    const key = `${client_id}__${vehicle_id}`;
    const prev = clientVehicleGroups.get(key) || {
      owner_id: client_id,
      owner_name: client_name || null,
      client_id,
      client_type,
      client_name: client_name || null,
      vehicle_owner_id: owner_id,
      vehicle_owner_name: owner_name || null,
      vehicle_id,
      vehicle_plate: vehicle_plate || null,
      total: 0,
    };
    prev.total += rowNet;
    clientVehicleGroups.set(key, prev);
  }

  const account_type = data.account_type ?? null;
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(
      `[FinancialService] account_type must be one of: ${ACCOUNT_TYPES.join(', ')}, or null.`
    );
  }

  const receipt_date = data.receipt_date;
  if (!receipt_date || isNaN(Date.parse(receipt_date))) {
    throw new Error('[FinancialService] receipt_date must be a valid ISO date string.');
  }

  // Convert decimals → cents (RULE 9)
  const total = Money.toCents(data.total);
  if (total < 0) {
    throw new Error('[FinancialService] total must be a non-negative number.');
  }

  const general_discount = 0; // removed from system
  const general_add = Money.toCents(data.general_add ?? data.generalAdd ?? 0);
  if (general_add < 0) {
    throw new Error('[FinancialService] general_add must be a non-negative number.');
  }
  const previous_balance = Money.toCents(data.previous_balance ?? data.previousBalance ?? 0);
  const net_due_calc = total + general_add;
  const net_due_input = data.net_due != null ? Money.toCents(data.net_due) : null;
  const net_due = net_due_input != null ? net_due_input : net_due_calc;
  const net_total = net_due + previous_balance;

  const paid = Money.toCents(data.paid ?? 0);
  if (paid < 0) {
    throw new Error('[FinancialService] paid must be a non-negative number.');
  }

  const groups = [...clientVehicleGroups.values()].filter(g => g.total !== 0);
  if (groups.length === 0) {
    throw new Error('[FinancialService] rows total must be greater than zero.');
  }

  return {
    account_type,
    receipt_date,
    total,
    general_add,
    general_discount,
    net_due,
    previous_balance,
    net_total,
    paid,
    groups,
    client_id,
    client_type,
    client_name,
  };
}

// ─── PRIVATE: BUILD REVERSE OPS ───────────────────────────────────────────────

async function _buildReverseOps(receiptId, username, tx = DB) {
  const ops = [];
  const now = new Date().toISOString();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };

  const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', receiptId);
  for (const entry of treasuryEntries) {
    if (entry.reference_type !== REF_TYPE) continue;
    if (entry.is_reversed === true)        continue;
    ops.push({ op: 'update', store: STORE.TREASURY, id: entry.id, patch: reversePatch });
  }

  const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', receiptId);
  for (const entry of ledgerEntries) {
    if (entry.reference_type !== REF_TYPE) continue;
    if (entry.is_reversed === true)        continue;
    ops.push({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch });
  }

  return ops;
}

// ─── PRIVATE: DUPLICATE GUARD ─────────────────────────────────────────────────

async function _assertNotApplied(receiptId, tx = DB) {
  const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', receiptId);
  const hasActiveTreasury = treasuryEntries.some(
    e => e.reference_type === REF_TYPE && e.is_reversed === false
  );
  if (hasActiveTreasury) {
    throw new Error(`[FinancialService] Receipt already applied: ${receiptId}`);
  }

  const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', receiptId);
  const hasActiveLedger = ledgerEntries.some(
    e => e.reference_type === REF_TYPE && e.is_reversed === false
  );
  if (hasActiveLedger) {
    throw new Error(`[FinancialService] Receipt already applied: ${receiptId}`);
  }
}

// ─── PRIVATE: BUILD APPLY OPS ──────────────────────────────────────────────────

function _buildApplyOps(username, clean, receiptId) {
  const {
    receipt_date,
    net_due,
    client_id,
    client_type,
    client_name,
  } = clean;

  const ops = [];

  if (net_due !== 0) {
    ops.push({
      op: 'add', store: STORE.LEDGER,
      payload: {
        username,
        owner_id      : client_id,
        owner_name    : client_name || null,
        client_id     : client_id,
        client_type   : client_type,
        client_name   : client_name || null,
        vehicle_owner_id  : null,
        vehicle_owner_name: null,
        vehicle_id    : null,
        vehicle_plate : null,
        type           : 'receipt_due',
        amount         : net_due,
        reference_type : REF_TYPE,
        reference_id   : receiptId,
        date           : receipt_date,
        applied_at     : new Date().toISOString(),
        is_reversed    : false,
        note           : `Receipt ${receiptId} — net due`,
      },
    });
  }

  return ops;
}

// ─── OFFICE BALANCE: PRICE RESOLUTION ───────────────────────────────────────

async function resolveHamolaPrice(username, officeName, loadingPlace, destinationPlace, officeMap = null) {
  if (!username) throw new Error('[FinancialService:resolveHamolaPrice] username is required.');

  const name = _requireText(officeName, 'office_name');
  const loading = _requireText(loadingPlace, 'loading_place');
  const destination = _requireText(destinationPlace, 'destination');

  let map = officeMap;
  if (!map) {
    const offices = await DB.findByFields(STORE.OFFICES, { username });
    map = new Map(offices.map((o) => [_toKey(o.name), o]));
  }

  const office = map.get(_toKey(name));
  if (!office) {
    throw new Error(`❌ الشركة غير موجودة: ${name}`);
  }

  const hamola = Array.isArray(office.hamolaRows) ? office.hamolaRows : [];
  const match = hamola.find((row) => {
    const loadKey = _toKey(row.loading_place ?? row.loading);
    const destKey = _toKey(row.destination_place ?? row.direction ?? row.taktik);
    return loadKey === _toKey(loading) && destKey === _toKey(destination);
  });

  if (!match) {
    throw new Error(`❌ لا يوجد سعر مطابق للشركة "${name}" لمسار (${loading} → ${destination})`);
  }

  const price = Number(match.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`❌ سعر التحميل غير صالح للشركة "${name}" لمسار (${loading} → ${destination})`);
  }

  return { office, price };

}
// ─── PRIVATE: PARSE APPLY RESULTS ─────────────────────────────────────────────

function _parseApplyResults(applyResults) {
  let ledger_due = null;

  for (const entry of applyResults || []) {
    if (!entry) continue;
    if (entry.type === 'receipt_due') {
      ledger_due = entry;
      break;
    }
  }

  return {
    treasury: null,
    ledger_deposit: null,
    ledger_withdraw: null,
    ledger_due,
  };
}

// ─── PUBLIC: createReceipt ─────────────────────────────────────────────────────

async function createReceipt(username, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:create] username is required.');

  const receiptId = data.id || _uuid();
  const clean = _validate(data);

  const firstDataRow = (Array.isArray(data.rows) ? data.rows : []).find(r => r && r._type !== 'separator') || null;
  const payout_status = _normalizePayoutStatus(data.payout_status) || RECEIPT_PAYOUT_STATUS.UNPAID;
  const receiptOp = {
    op: 'add', store: STORE.RECEIPTS,
    payload: {
      id           : receiptId,
      username,
      client_id    : clean.client_id,
      client_type  : clean.client_type,
      client_name  : clean.client_name,
      owner_name   : clean.client_type === 'owner' ? clean.client_name : null,
      owner_id     : clean.client_type === 'owner' ? clean.client_id : null,
      vehicle_id   : data.vehicle_id ?? firstDataRow?.vehicle_id ?? null,
      account_type : clean.account_type,
      receipt_date : clean.receipt_date,
      receipt_number: data.receipt_number ?? null,
      payout_status : payout_status,
      rows         : data.rows ?? [],
      total        : clean.total,
      paid         : clean.paid,
      previous_balance: clean.previous_balance,
      general_discount: clean.general_discount,
      general_add     : clean.general_add,
      net_due         : clean.net_due,
      net_total       : clean.net_total,
      notes          : data.notes ?? null,
      shipping_number: data.shipping_number ?? null,
    },
  };

  const applyOps = _buildApplyOps(username, clean, receiptId);
  const allOps = [receiptOp, ...applyOps, ...extraOps];
  const allResults = await DB.transaction(async (tx) => {
    await _assertNotApplied(receiptId, tx);
    return tx.runOps(allOps);
  }, { username, stores: _storesForOps(allOps, [STORE.RECEIPTS, STORE.TREASURY, STORE.LEDGER]) });

  const receipt      = Money.decimalizeRecord(allResults[0]);
  const applyResults = allResults.slice(1, 1 + applyOps.length);
  const { treasury, ledger_deposit, ledger_withdraw, ledger_due } = _parseApplyResults(applyResults);

  return {
    receipt,
    treasury       : Money.decimalizeRecord(treasury),
    ledger_deposit : Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due     : Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: updateReceipt ─────────────────────────────────────────────────────

async function updateReceipt(username, id, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:update] username is required.');
  if (!id)       throw new Error('[FinancialService:update] id is required.');

  const clean    = _validate(data);
  const firstDataRow = (Array.isArray(data.rows) ? data.rows : []).find(r => r && r._type !== 'separator') || null;
  const payout_status = _normalizePayoutStatus(data.payout_status);
  const updateOp = {
    op: 'update', store: STORE.RECEIPTS, id,
    patch: {
      username,
      client_id    : clean.client_id,
      client_type  : clean.client_type,
      client_name  : clean.client_name,
      owner_name   : clean.client_type === 'owner' ? clean.client_name : null,
      owner_id     : clean.client_type === 'owner' ? clean.client_id : null,
      vehicle_id   : data.vehicle_id ?? firstDataRow?.vehicle_id ?? null,
      account_type : clean.account_type,
      receipt_date : clean.receipt_date,
      receipt_number: data.receipt_number ?? null,
      ...(payout_status !== null ? { payout_status } : {}),
      rows         : data.rows ?? [],
      total        : clean.total,
      paid         : clean.paid,
      previous_balance: clean.previous_balance,
      general_discount: clean.general_discount,
      general_add     : clean.general_add,
      net_due         : clean.net_due,
      net_total       : clean.net_total,
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.shipping_number !== undefined ? { shipping_number: data.shipping_number || null } : {}),
    },
  };

  const applyOps = _buildApplyOps(username, clean, id);
  // Phase 2 TASK E — extraOps lets the caller (ReceiptsModule.update) atomically
  // unlink stale used_receipt_id references in bolsaForms and re-link new ones,
  // all inside the same DB transaction as the receipt update.
  const allTxOps = [updateOp, ...applyOps, ...extraOps];
  const txResult = await DB.transaction(async (tx) => {
    const existing = await tx.getById(STORE.RECEIPTS, id);
    if (!existing) {
      throw new Error(`[FinancialService:update] Receipt ${id} not found or deleted.`);
    }
    const reverseOps = await _buildReverseOps(id, username, tx);
    const results = await tx.runOps([...reverseOps, ...allTxOps]);
    return { results, reverseCount: reverseOps.length };
  }, { username, stores: _storesForOps(allTxOps, [STORE.RECEIPTS, STORE.TREASURY, STORE.LEDGER]) });

  const allResults = txResult.results;
  const reverseCount = txResult.reverseCount;
  const receiptIdx   = reverseCount;
  const receipt      = Money.decimalizeRecord(allResults[receiptIdx]);
  const applyResults = allResults.slice(receiptIdx + 1, receiptIdx + 1 + applyOps.length);
  const { treasury, ledger_deposit, ledger_withdraw, ledger_due } = _parseApplyResults(applyResults);

  return {
    receipt,
    treasury       : Money.decimalizeRecord(treasury),
    ledger_deposit : Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due     : Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: deleteReceipt ─────────────────────────────────────────────────────

async function deleteReceipt(username, id, extraOps = []) {
  if (!username) throw new Error('[FinancialService:delete] username is required.');
  if (!id)       throw new Error('[FinancialService:delete] id is required.');

  // Phase 2 TASK E — extraOps lets the caller atomically unlink any bolsa
  // rows that pointed back to this receipt.  They are inserted BEFORE the
  // receipt delete op so the soft-deleted receipt remains the last op,
  // preserving the existing result-shape contract (caller still reads the
  // deleted receipt from allResults[length-1]-equivalent index).
  const txResult = await DB.transaction(async (tx) => {
    const existing = await tx.getById(STORE.RECEIPTS, id);
    if (!existing) {
      throw new Error(`[FinancialService:delete] Receipt ${id} not found or already deleted.`);
    }

    const reverseOps = await _buildReverseOps(id, username, tx);
    const originalNumber = existing.receipt_number;
    const newNumber = `${originalNumber}_deleted_${_uuid().slice(0, 8)}`;

    const deleteOp = {
      op: 'delete',
      store: STORE.RECEIPTS,
      id,
      patch: {
        receipt_number: newNumber,
        deleted_original_number: originalNumber
      }
    };

    // Ops order: reverse-financial → extra-bolsa-unlink → soft-delete-receipt.
    // The receipt result is always the LAST element, so the caller's
    // existing `allResults[length - 1]` lookup remains correct.
    const allTxOps = [...reverseOps, ...extraOps, deleteOp];
    const results = await tx.runOps(allTxOps);
    return {
      results,
      treasury_count: reverseOps.filter(o => o.store === STORE.TREASURY).length,
      ledger_count: reverseOps.filter(o => o.store === STORE.LEDGER).length,
    };
  }, { username, stores: _storesForOps(extraOps, [STORE.RECEIPTS, STORE.TREASURY, STORE.LEDGER]) });

  const allResults = txResult.results;
  const receipt = Money.decimalizeRecord(allResults[allResults.length - 1]);

  return {
    receipt,
    reversed: {
      treasury_count: txResult.treasury_count,
      ledger_count: txResult.ledger_count,
    },
  };
}

// ─── PUBLIC: updateReceiptStatus ─────────────────────────────────────────────

async function updateReceiptStatus(username, receiptId, status) {
  if (!username) throw new Error('[FinancialService:updateReceiptStatus] username is required.');
  if (!receiptId) throw new Error('[FinancialService:updateReceiptStatus] receiptId is required.');

  const normalized = _normalizePayoutStatus(status);
  if (!normalized) {
    throw new Error('[FinancialService:updateReceiptStatus] status must be paid or unpaid.');
  }

  const result = await DB.transaction(async (tx) => {
    const existing = await tx.getById(STORE.RECEIPTS, String(receiptId));
    if (!existing) {
      throw new Error(`[FinancialService:updateReceiptStatus] Receipt ${receiptId} not found.`);
    }
    if (existing.username !== username) {
      throw new Error('[FinancialService:updateReceiptStatus] cross-user access is forbidden.');
    }

    const currentStatus = String(existing.payout_status || 'unpaid');

    // ── Same status → no-op ─────────────────────────────────────────────
    if (currentStatus === normalized) {
      return { receipt: existing, changed: false };
    }

    const now = new Date().toISOString();
    const paidAmount = Number(existing.paid) || 0;   // already in cents (DB)

    // ── unpaid → paid: CREATE financial entries ─────────────────────────
    if (normalized === 'paid') {
      const ops = [];

      // Update receipt status
      ops.push({
        op: 'update',
        store: STORE.RECEIPTS,
        id: String(receiptId),
        patch: {
          payout_status: 'paid',
          paid_at: now,
        },
      });

      // entity_ledger: receipt_payment — withdraw from client balance
      if (paidAmount > 0) {
        ops.push({
          op: 'add',
          store: STORE.LEDGER,
          payload: {
            username,
            owner_id       : String(existing.client_id),
            owner_name     : existing.client_name || null,
            client_id      : String(existing.client_id),
            client_type    : existing.client_type || 'owner',
            client_name    : existing.client_name || null,
            vehicle_id     : null,
            vehicle_plate  : null,
            type           : 'receipt_payment',
            amount         : paidAmount,
            reference_type : REF_TYPE,
            reference_id   : String(receiptId),
            receipt_number : existing.receipt_number || null,
            date           : existing.receipt_date || now,
            applied_at     : now,
            is_reversed    : false,
            note           : `صرف نموذج ${existing.receipt_number || receiptId}`,
          },
        });

        // treasury: cash_out — cash leaves the drawer
        ops.push({
          op: 'add',
          store: STORE.TREASURY,
          payload: {
            username,
            type           : 'withdraw',
            effect         : 'receipt_payout',
            amount         : paidAmount,
            account_type   : 'cash',
            reference_type : REF_TYPE,
            reference_id   : String(receiptId),
            receipt_number : existing.receipt_number || null,
            client_id      : String(existing.client_id),
            client_type    : existing.client_type || 'owner',
            client_name    : existing.client_name || null,
            date           : existing.receipt_date || now,
            applied_at     : now,
            is_reversed    : false,
            note           : `صرف نموذج ${existing.receipt_number || receiptId}`,
          },
        });
      }

      const results = await tx.runOps(ops);
      return { receipt: results[0], changed: true };
    }

    // ── paid → unpaid: REVERSE financial entries ────────────────────────
    if (normalized === 'unpaid') {
      const reversePatch = {
        is_reversed: true,
        reversed_at: now,
        reversed_by: username,
      };

      const ops = [];

      // Find and reverse all active payout entries for this receipt
      const ledgerEntries = await tx.getByIndex(STORE.LEDGER, 'by_reference_id', String(receiptId));
      for (const entry of ledgerEntries) {
        if (entry.reference_type !== REF_TYPE) continue;
        if (entry.type !== 'receipt_payment') continue;
        if (entry.is_reversed === true) continue;
        ops.push({ op: 'update', store: STORE.LEDGER, id: entry.id, patch: reversePatch });
      }

      const treasuryEntries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', String(receiptId));
      for (const entry of treasuryEntries) {
        if (entry.reference_type !== REF_TYPE) continue;
        if (entry.effect !== 'receipt_payout') continue;
        if (entry.is_reversed === true) continue;
        ops.push({ op: 'update', store: STORE.TREASURY, id: entry.id, patch: reversePatch });
      }

      // Update receipt status
      ops.push({
        op: 'update',
        store: STORE.RECEIPTS,
        id: String(receiptId),
        patch: {
          payout_status: 'unpaid',
          paid_at: null,
        },
      });

      const results = await tx.runOps(ops);
      return { receipt: results[results.length - 1], changed: true };
    }

    throw new Error('[FinancialService:updateReceiptStatus] unexpected status value.');
  }, { username, stores: [STORE.RECEIPTS, STORE.LEDGER, STORE.TREASURY] });

  return Money.decimalizeRecord(result.receipt);
}

// ─── PUBLIC: rebuildVehicleBalance ────────────────────────────────────────────

async function rebuildVehicleBalance(vehicle_id) {
  if (!vehicle_id) throw new Error('[FinancialService:rebuildVehicleBalance] vehicle_id is required.');

  const allEntries = await DB.getByIndex(STORE.LEDGER, 'by_vehicle', vehicle_id);
  const active     = allEntries.filter(e => e.is_reversed === false && e.deleted_at === null);

  let deposit_total  = 0;
  let withdraw_total = 0;

  for (const entry of active) {
    if (entry.type === 'deposit')  deposit_total  += Number(entry.amount) || 0;
    if (entry.type === 'withdraw') withdraw_total += Number(entry.amount) || 0;
  }

  const balance = deposit_total - withdraw_total;

  return {
    vehicle_id,
    balance        : Money.toDecimal(balance),
    deposit_total  : Money.toDecimal(deposit_total),
    withdraw_total : Money.toDecimal(withdraw_total),
    entry_count    : active.length,
  };
}

// ─── PUBLIC: rebuildTreasuryBalance ───────────────────────────────────────────

async function rebuildTreasuryBalance(account_type = null) {
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(
      `[FinancialService:rebuildTreasuryBalance] Invalid account_type "${account_type}". ` +
      `Allowed: ${ACCOUNT_TYPES.join(', ')}, or omit for all.`
    );
  }

  const allEntries = await DB.getAll(STORE.TREASURY);
  const active     = allEntries.filter(e => e.is_reversed === false && e.deleted_at === null);

  function _calcAccount(entries) {
    let deposit_total  = 0;
    let withdraw_total = 0;
    for (const e of entries) {
      if (e.type === 'deposit')  deposit_total  += Number(e.amount) || 0;
      if (e.type === 'withdraw') withdraw_total += Number(e.amount) || 0;
    }
    return {
      balance        : Money.toDecimal(deposit_total - withdraw_total),
      deposit_total  : Money.toDecimal(deposit_total),
      withdraw_total : Money.toDecimal(withdraw_total),
      entry_count    : entries.length,
    };
  }

  if (account_type !== null) {
    const filtered = active.filter(e => e.account_type === account_type);
    return { account_type, ..._calcAccount(filtered) };
  }

  const result   = {};
  let   cBal = 0, cDep = 0, cWith = 0, cCount = 0;

  for (const acct of ACCOUNT_TYPES) {
    const filtered  = active.filter(e => e.account_type === acct);
    const snap      = _calcAccount(filtered);
    result[acct]    = snap;
    cDep   += Money.toCents(snap.deposit_total);
    cWith  += Money.toCents(snap.withdraw_total);
    cCount += snap.entry_count;
  }
  cBal = cDep - cWith;

  result.combined = {
    balance        : Money.toDecimal(cBal),
    deposit_total  : Money.toDecimal(cDep),
    withdraw_total : Money.toDecimal(cWith),
    entry_count    : cCount,
  };

  return result;
}

// ─── CLIENT LEDGER & BALANCE ───────────────────────────────────────────────────

async function getClientLedger(client_id) {
  const key = client_id != null ? String(client_id).trim() : '';
  if (!key) throw new Error('[FinancialService:getClientLedger] client_id is required.');

  const entries = await DB.findByFields(STORE.LEDGER, {
    owner_id: key,
    is_reversed: false,
  });

  return entries
    .slice()
    .sort((a, b) => {
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      return db - da;
    })
    .map(Money.decimalizeRecord);
}

async function getClientBalance(client_id) {
  const ledger = await getClientLedger(client_id);
  let deposit_total = 0;
  let withdraw_total = 0;

  for (const entry of ledger) {
    // entry.amount is already decimal (from decimalizeRecord)
    // convert back to cents for safe integer arithmetic
    const cents = Money.toCents(entry.amount);
    const isOfficeEntry = entry.entity_type === 'office'
      || entry.type === OFFICE_LEDGER_TYPES.DEPOSIT
      || entry.type === OFFICE_LEDGER_TYPES.WITHDRAW_AUTO;

    if (isOfficeEntry) {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_due') {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_payment') {
      withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'deposit') deposit_total += cents;
    if (entry.type === 'withdraw') withdraw_total += cents;
  }

  return {
    client_id: String(client_id),
    balance: Money.toDecimal(deposit_total - withdraw_total),
    deposit_total: Money.toDecimal(deposit_total),
    withdraw_total: Money.toDecimal(withdraw_total),
    entry_count: ledger.length,
    last_transaction_date: ledger[0]?.date || ledger[0]?.applied_at || ledger[0]?.created_at || null,
  };
}

async function createClientBalanceEntry(username, data) {
  if (!username) throw new Error('[FinancialService:createClientBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createClientBalanceEntry] data must be a plain object.');
  }

  const client_id = data.client_id != null
    ? String(data.client_id).trim()
    : (data.entity_id != null ? String(data.entity_id).trim() : (data.office_id != null ? String(data.office_id).trim() : ''));
  let client_type = data.client_type;
  if (client_type !== 'owner' && client_type !== 'office') {
    if (data.entity_type === 'office' || data.office_id) client_type = 'office';
    else if (data.entity_type === 'owner') client_type = 'owner';
  }
  client_type = client_type === 'owner' || client_type === 'office'
    ? client_type
    : '';
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';
  const type = data.type === 'deposit' || data.type === 'withdraw' ? data.type : '';
  const amount = Money.toCents(data.amount);
  const date = data.date;
  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : (type === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد');

  if (!client_id) throw new Error('[FinancialService:createClientBalanceEntry] client_id is required.');
  if (!client_type) throw new Error('[FinancialService:createClientBalanceEntry] client_type must be owner or office.');
  if (!type) throw new Error('[FinancialService:createClientBalanceEntry] type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createClientBalanceEntry] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createClientBalanceEntry] date must be a valid ISO date string.');
  }

  const referenceId = _uuid();
  const [entry] = await DB.transaction([{
    op: 'add',
    store: STORE.LEDGER,
    payload: {
      username,
      owner_id: client_id,
      owner_name: client_name || null,
      client_id,
      client_type,
      client_name: client_name || null,
      vehicle_id: null,
      vehicle_plate: null,
      type,
      amount,
      entity_type: client_type,
      entity_id: client_id,
      reference_type: 'client_balance',
      reference_id: referenceId,
      date,
      applied_at: new Date().toISOString(),
      is_reversed: false,
      note,
    },
  }], { username });

  return Money.decimalizeRecord(entry);
}

async function createOfficeDeposit(username, data) {
  if (!username) throw new Error('[FinancialService:createOfficeDeposit] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createOfficeDeposit] data must be a plain object.');
  }

  const office_id = String(data.office_id || data.entity_id || data.client_id || '').trim();
  if (!office_id) throw new Error('[FinancialService:createOfficeDeposit] office_id is required.');

  const amount = Money.toCents(data.amount);
  if (amount <= 0) throw new Error('[FinancialService:createOfficeDeposit] amount must be greater than zero.');

  const date = data.date || new Date().toISOString().split('T')[0];
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createOfficeDeposit] date must be a valid ISO date string.');
  }

  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : 'إيداع رصيد';

  const referenceId = _uuid();
  const [entry] = await DB.transaction(async (tx) => {
    const office = await tx.getById(STORE.OFFICES, office_id);
    if (!office || office.deleted_at !== null) {
      throw new Error('[FinancialService:createOfficeDeposit] office not found.');
    }
    if (office.username !== username) {
      throw new Error('[FinancialService:createOfficeDeposit] cross-user access is forbidden.');
    }

    return tx.runOps([{
      op: 'add',
      store: STORE.LEDGER,
      payload: {
        username,
        owner_id: String(office.id),
        owner_name: office.name || null,
        client_id: String(office.id),
        client_type: 'office',
        client_name: office.name || null,
        vehicle_owner_id: null,
        vehicle_owner_name: null,
        vehicle_id: null,
        vehicle_plate: null,
        type: OFFICE_LEDGER_TYPES.DEPOSIT,
        amount,
        entity_type: 'office',
        entity_id: String(office.id),
        reference_type: 'office_deposit',
        reference_id: referenceId,
        date,
        applied_at: new Date().toISOString(),
        is_reversed: false,
        note,
      },
    }]);
  }, { username, stores: [STORE.OFFICES, STORE.LEDGER] });

  return Money.decimalizeRecord(entry);
}

// ─── BOLSA OPERATIONS ──────────────────────────────────────────────────────────

async function createBolsaForm(username, data) {
  if (!username) throw new Error('[FinancialService:createBolsaForm] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createBolsaForm] data must be a plain object.');
  }

  const bolsaId = String(data.id || '').trim();
  const agentId = String(data.agent_id || '').trim();
  const bolsaDate = data.bolsa_date;
  const rawRows = Array.isArray(data.rows) ? data.rows : [];

  if (!bolsaId) throw new Error('[FinancialService:createBolsaForm] id is required.');
  if (!agentId) throw new Error('[FinancialService:createBolsaForm] agent_id is required.');
  if (!bolsaDate || isNaN(Date.parse(bolsaDate))) {
    throw new Error('[FinancialService:createBolsaForm] bolsa_date must be a valid ISO date string.');
  }
  if (rawRows.length === 0) throw new Error('[FinancialService:createBolsaForm] rows must be a non-empty array.');

  // Normalize rows once, server-side, so the stored shape is the canonical
  // shape regardless of which caller built the payload.
  const rows = rawRows.map(_normalizeBolsaRow);

  // Server-side total calculation is the source of truth.  Caller-supplied
  // totals are ignored — the only authoritative value is what we compute
  // here from the normalized rows + the addition input.
  //
  // `data.addition` is the canonical input field; `data.totals?.addition`
  // is accepted only as a fallback for callers that still pre-build a
  // totals object (forward compatibility).
  const additionInput = data.addition != null
    ? data.addition
    : (data.totals && data.totals.addition);
  const totals = _calcBolsaTotals(rows, additionInput);
  const grandTotal = totals.grand_total;
  const cents = Money.toCents(grandTotal);

  const [saved] = await DB.transaction(async (tx) => {
    const agentKey = Number.isNaN(Number(agentId)) ? agentId : Number(agentId);
    const agent = await tx.getById('agents', agentKey);
    if (!agent || agent.deleted_at !== null || agent.agent_kind !== 'mandoub') {
      throw new Error('❌ المندوب غير موجود');
    }
    const agentOwner = typeof agent.username === 'string' && agent.username.trim()
      ? agent.username.trim()
      : (typeof agent.created_by === 'string' && agent.created_by.trim() ? agent.created_by.trim() : null);
    if (agentOwner && agentOwner !== String(username)) {
      throw new Error('❌ المندوب غير موجود');
    }

    // Unified integrity check: in-tx so it serializes with concurrent saves.
    await _assertBolsaIntegrity(tx, username, { rows, excludeFormId: null });

    const newBalance = Money.round((Number(agent.balance) || 0) - grandTotal);
    const ops = [
      {
        type: 'add',
        store: 'bolsaForms',
        payload: {
          id: bolsaId,
          username,
          bolsa_date: bolsaDate,
          agent_id: agentId,
          rows,
          totals: {
            ohda: totals.ohda,
            dokhan: totals.dokhan,
            addition: totals.addition, // FIX #1 — persist addition
            grand_total: grandTotal,
          },
        },
      },
      {
        type: 'update',
        store: 'agents',
        id: agent.id,
        patch: { balance: newBalance },
      },
      {
        type: 'add',
        store: 'treasury',
        payload: {
          type: 'withdraw',
          effect: 'bolsa_deduction',
          amount: cents,
          account_type: 'cash',
          reference_type: 'bolsa',
          reference_id: bolsaId,
          agent_id: String(agent.id),
          client_id: String(agent.id),
          client_type: 'mandoub',
          client_name: agent.name || null,
          date: bolsaDate,
          applied_at: new Date().toISOString(),
          is_reversed: false,
          note: `خصم مندوب من تفريغ البوالص (${String(bolsaId)})`,
        },
      },
    ];

    return tx.runOps(ops);
  }, { username, stores: ['bolsaForms', 'agents', STORE.TREASURY, 'vehicleOwners'] });

  // FIX #4 — service-owned dispatch, fires only after tx commits.
  _emit('bolsaForms:changed');
  _emit('agents:changed');

  return saved;
}

async function getBolsaForms(username) {
  if (!username) throw new Error('[FinancialService:getBolsaForms] username is required.');
  const forms = await DB.getByIndex('bolsaForms', 'by_username', username);
  return forms.map(Money.decimalizeRecord);
}

async function getBolsaForm(username, id) {
  if (!username) throw new Error('[FinancialService:getBolsaForm] username is required.');
  if (!id) throw new Error('[FinancialService:getBolsaForm] id is required.');
  const form = await DB.getById('bolsaForms', String(id));
  if (!form) return null;
  if (form.username !== username) {
    throw new Error('[FinancialService:getBolsaForm] cross-user access is forbidden.');
  }
  return Money.decimalizeRecord(form);
}

async function _reverseBolsaTreasuryOps(bolsaId, username, tx = DB) {
  const entries = await tx.getByIndex(STORE.TREASURY, 'by_reference_id', bolsaId);
  const now = new Date().toISOString();
  const reversePatch = { is_reversed: true, reversed_at: now, reversed_by: username };
  return entries
    .filter((entry) => entry.reference_type === BOLSA_REF_TYPE && entry.is_reversed === false)
    .map((entry) => ({ op: 'update', store: STORE.TREASURY, id: entry.id, patch: reversePatch }));
}

async function updateBolsaForm(username, id, data) {
  if (!username) throw new Error('[FinancialService:updateBolsaForm] username is required.');
  if (!id) throw new Error('[FinancialService:updateBolsaForm] id is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:updateBolsaForm] data must be a plain object.');
  }

  const bolsaId = String(id).trim();
  const bolsaDate = data.bolsa_date;
  const agentId = String(data.agent_id || '').trim();
  const rawRows = Array.isArray(data.rows) ? data.rows : [];

  if (!agentId) throw new Error('[FinancialService:updateBolsaForm] agent_id is required.');
  if (!bolsaDate || isNaN(Date.parse(bolsaDate))) {
    throw new Error('[FinancialService:updateBolsaForm] bolsa_date must be a valid ISO date string.');
  }
  if (rawRows.length === 0) throw new Error('[FinancialService:updateBolsaForm] rows must be a non-empty array.');

  // Same normalization + total pipeline as CREATE (FIX #2).
  const rows = rawRows.map(_normalizeBolsaRow);

  // FIX #1 — `addition` is now the canonical input.  Caller-supplied
  // totals.grand_total is no longer trusted (it was a dormant override
  // path with no real use case in the codebase).
  const additionInput = data.addition != null
    ? data.addition
    : (data.totals && data.totals.addition);
  const totals = _calcBolsaTotals(rows, additionInput);
  const nextGrandTotal = totals.grand_total;

  const results = await DB.transaction(async (tx) => {
    const existing = await tx.getById('bolsaForms', String(id));
    if (!existing) {
      throw new Error(`[FinancialService:updateBolsaForm] Bolsa ${id} not found.`);
    }
    if (existing.username !== username) {
      throw new Error('[FinancialService:updateBolsaForm] cross-user access is forbidden.');
    }

    // FIX #2 — UPDATE now enforces the same integrity rules as CREATE.
    // FIX #3 — uniqueness scan runs INSIDE the tx, excluding the form
    // being edited so re-saving an existing form is allowed.
    await _assertBolsaIntegrity(tx, username, { rows, excludeFormId: bolsaId });

    const currentGrandTotal = Number(existing.totals?.grand_total) || 0;
    const oldAgentKey = Number.isNaN(Number(existing.agent_id)) ? existing.agent_id : Number(existing.agent_id);
    const oldAgent = await tx.getById('agents', oldAgentKey);
    if (!oldAgent) {
      throw new Error('[FinancialService:updateBolsaForm] original agent not found.');
    }

    const newAgentKey = Number.isNaN(Number(agentId)) ? agentId : Number(agentId);
    const newAgent = await tx.getById('agents', newAgentKey);
    if (!newAgent || newAgent.deleted_at !== null || newAgent.agent_kind !== 'mandoub') {
      throw new Error('❌ المندوب غير موجود');
    }
    const newAgentOwner = typeof newAgent.username === 'string' && newAgent.username.trim()
      ? newAgent.username.trim()
      : (typeof newAgent.created_by === 'string' && newAgent.created_by.trim() ? newAgent.created_by.trim() : null);
    if (newAgentOwner && newAgentOwner !== String(username)) {
      throw new Error('❌ المندوب غير موجود');
    }

    const reverseOps = await _reverseBolsaTreasuryOps(bolsaId, username, tx);

    const sameAgent = String(oldAgent.id) === String(newAgent.id);
    const balanceOps = sameAgent
      ? [{
          op: 'update',
          store: 'agents',
          id: oldAgent.id,
          patch: {
            balance: Money.round((Number(oldAgent.balance) || 0) + currentGrandTotal - nextGrandTotal),
          },
        }]
      : [
          {
            op: 'update',
            store: 'agents',
            id: oldAgent.id,
            patch: {
              balance: Money.round((Number(oldAgent.balance) || 0) + currentGrandTotal),
            },
          },
          {
            op: 'update',
            store: 'agents',
            id: newAgent.id,
            patch: {
              balance: Money.round((Number(newAgent.balance) || 0) - nextGrandTotal),
            },
          },
        ];

    const ops = [
      ...reverseOps,
      ...balanceOps,
      {
        op: 'update',
        store: 'bolsaForms',
        id: bolsaId,
        patch: {
          bolsa_date: bolsaDate,
          agent_id: agentId,
          rows,
          totals: {
            ohda: totals.ohda,
            dokhan: totals.dokhan,
            addition: totals.addition, // FIX #1 — persist addition
            grand_total: nextGrandTotal,
          },
        },
      },
      {
        op: 'add',
        store: STORE.TREASURY,
        payload: {
          type: 'withdraw',
          effect: 'bolsa_deduction',
          amount: Money.toCents(nextGrandTotal),
          account_type: 'cash',
          reference_type: BOLSA_REF_TYPE,
          reference_id: bolsaId,
          agent_id: String(newAgent.id),
          client_id: String(newAgent.id),
          client_type: 'mandoub',
          client_name: newAgent.name || null,
          date: bolsaDate,
          applied_at: new Date().toISOString(),
          is_reversed: false,
          note: `خصم مندوب من تفريغ البوالص (${String(bolsaId)})`,
        },
      },
    ];

    return tx.runOps(ops);
  }, { username, stores: ['bolsaForms', 'agents', STORE.TREASURY, 'vehicleOwners'] });

  const [saved] = results;

  // FIX #4 — service-owned dispatch.
  _emit('bolsaForms:changed');
  _emit('agents:changed');

  return Money.decimalizeRecord(saved);
}

async function deleteBolsaForm(username, id) {
  if (!username) throw new Error('[FinancialService:deleteBolsaForm] username is required.');
  if (!id) throw new Error('[FinancialService:deleteBolsaForm] id is required.');

  const results = await DB.transaction(async (tx) => {
    const existing = await tx.getById('bolsaForms', String(id));
    if (!existing) {
      throw new Error(`[FinancialService:deleteBolsaForm] Bolsa ${id} not found.`);
    }
    if (existing.username !== username) {
      throw new Error('[FinancialService:deleteBolsaForm] cross-user access is forbidden.');
    }

    const grandTotal = Number(existing.totals?.grand_total) || 0;
    const agentDelKey = Number.isNaN(Number(existing.agent_id)) ? existing.agent_id : Number(existing.agent_id);
    const agent = await tx.getById('agents', agentDelKey);
    if (!agent) {
      throw new Error('[FinancialService:deleteBolsaForm] agent not found.');
    }

    const reverseOps = await _reverseBolsaTreasuryOps(String(id), username, tx);
    const restoredBalance = Money.round((Number(agent.balance) || 0) + grandTotal);

    const ops = [
      ...reverseOps,
      {
        op: 'update',
        store: 'agents',
        id: agent.id,
        patch: { balance: restoredBalance },
      },
      {
        op: 'delete',
        store: 'bolsaForms',
        id: String(id),
      },
    ];

    return tx.runOps(ops);
  }, { username, stores: ['bolsaForms', 'agents', STORE.TREASURY] });

  // FIX #4 — service-owned dispatch; fixes stale balances on entities/
  // accounts pages after delete from allReceipts.
  _emit('bolsaForms:changed');
  _emit('agents:changed');

  return Money.decimalizeRecord(results[results.length - 1]);
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────


/**
 * Auto-update balance for a specific client's unpaid receipts.
 * Called when a receipt is paid or a salfa is given.
 * Finds other unpaid receipts for the SAME client and updates their balance.
 */
async function updateClientUnpaidBalances(clientId, username) {
  if (!clientId || !username) return;

  const allReceipts = await DB.getAll(STORE.RECEIPTS, { username });
  const unpaid = allReceipts.filter(r =>
    String(r.payout_status || 'unpaid') === 'unpaid'
    && String(r.client_id) === String(clientId)
  );
  if (unpaid.length === 0) return;

  let updated = false;

  for (const receipt of unpaid) {
    try {
      const ledger = await getClientLedger(String(receipt.client_id));

      let balanceCents = 0;
      for (const entry of ledger) {
        const cents = Money.toCents(entry.amount);
        if (entry.reference_id === String(receipt.id) && entry.reference_type === 'receipt') {
          continue;
        }
        if (entry.type === 'receipt_due') {
          balanceCents += cents;
        } else if (entry.type === 'receipt_payment') {
          balanceCents -= Math.abs(cents);
        } else if (entry.type === 'deposit') {
          balanceCents += cents;
        } else if (entry.type === 'withdraw') {
          balanceCents -= cents;
        } else if (entry.entity_type === 'office' || entry.type === OFFICE_LEDGER_TYPES.DEPOSIT || entry.type === OFFICE_LEDGER_TYPES.WITHDRAW_AUTO) {
          if (cents >= 0) balanceCents += cents;
          else balanceCents -= Math.abs(cents);
        }
      }

      const newPreviousBalance = balanceCents;
      const currentPrevious = Number(receipt.previous_balance) || 0;

      if (newPreviousBalance !== currentPrevious) {
        const netDue = Number(receipt.net_due) || 0;
        const newNetTotal = netDue + newPreviousBalance;
        const newPaid = newNetTotal;

        await DB.update(STORE.RECEIPTS, receipt.id, {
          previous_balance: newPreviousBalance,
          net_total: newNetTotal,
          paid: newPaid,
        }, { username });

        updated = true;
      }
    } catch (err) {
      console.warn('[updateClientUnpaidBalances] Error updating receipt', receipt.id, err);
    }
  }

  return updated;
}

export const FinancialService = Object.freeze({
  createReceipt,
  updateReceipt,
  deleteReceipt,
  rebuildVehicleBalance,
  rebuildTreasuryBalance,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  createOfficeDeposit,
  resolveHamolaPrice,
  createBolsaForm,
  getBolsaForms,
  getBolsaForm,
  updateBolsaForm,
  deleteBolsaForm,
  updateReceiptStatus,
  updateClientUnpaidBalances,
});
