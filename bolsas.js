/**
 * bolsas.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { DB } from './database.js';
import { FinancialService } from './financial.js';
import { AgentsService } from './entities.js';
import { OfficesService } from './offices.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { ExcelService } from './excelService.js';


// ========================================
// Services — BolsaFormsService
// ========================================

function _normalizeStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function _uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * saveBolsaForm — thin orchestration layer over FinancialService.
 *
 * ARCHITECTURE NOTE (Phase 1 refactor):
 *   All integrity rules (owner whitelist, intra-form karta uniqueness,
 *   global karta uniqueness, row normalization, total calculation) now
 *   live INSIDE FinancialService and run within the DB transaction.
 *   This layer only:
 *     - validates the page-level fields the service needs (date, agent)
 *     - verifies the mandoub up-front for a friendlier UX error
 *     - mints the id
 *     - forwards `addition` as a first-class field (no totals object)
 *
 *   Event dispatch is owned by FinancialService (service-owned events).
 *   This function MUST NOT dispatch bolsaForms:changed / agents:changed.
 */
async function saveBolsaForm(username, input) {
  if (!username) throw new Error('❌ المستخدم غير معروف');
  if (!input || typeof input !== 'object') throw new Error('❌ بيانات النموذج غير صحيحة');

  const bolsa_date = _normalizeStr(input.bolsa_date);
  const agent_id   = _normalizeStr(input.agent_id);
  const rows       = Array.isArray(input.rows) ? input.rows : [];

  if (!bolsa_date) throw new Error('❌ التاريخ مطلوب');
  if (!agent_id)   throw new Error('❌ يجب اختيار المندوب');
  if (rows.length === 0) throw new Error('❌ يجب إضافة صف واحد على الأقل');

  // Up-front mandoub check — friendlier than the service's generic error
  // when the user picked a now-deleted mandoub from the dropdown.
  const mandoub = await AgentsService.getMandoubById(agent_id);
  if (!mandoub) throw new Error('❌ المندوب غير موجود');

  return FinancialService.createBolsaForm(username, {
    id: _uuid(),
    bolsa_date,
    agent_id,
    rows,
    addition: Number(input.addition) || 0,
  });
}

const BolsaFormsService = Object.freeze({
  saveBolsaForm,
});



// ========================================
// Module — BolsaModule
// ========================================

/**
 * getOwners(username) — Phase 2 (TASK D).
 *
 * Returns the vehicleOwners owned by the current tenant.
 *
 * BEFORE: returned ALL owners across all tenants (cross-tenant leak).
 * AFTER:  scoped to `username` via the by_username index.
 *
 * BACKWARD COMPATIBILITY:
 *   Older internal callers used to call `BolsaModule.getOwners()` with no
 *   args.  To keep them working AND to surface any forgotten call site
 *   loudly during Phase 2 QA, when `username` is omitted we resolve it
 *   from AuthModule.getSession() and warn.  This avoids silent breakage
 *   while we sweep call sites.  If session is missing entirely we
 *   intentionally return an empty list (safe default — no datalist is
 *   better than every-tenant's datalist).
 *
 * MYSQL IMPACT:
 *   Becomes `SELECT * FROM vehicle_owners WHERE username = ? AND deleted_at IS NULL`.
 *   No schema change required — `vehicleOwners` already carries `username`
 *   and is indexed by `by_username`.
 */
async function getOwners(username) {
  if (!username) {
    const session = AuthModule.getSession();
    username = session?.username || '';
    if (!username) {
      console.warn('[BolsaModule:getOwners] No username available; returning empty list.');
      return [];
    }
  }
  return DB.getByIndex('vehicleOwners', 'by_username', username);
}

async function getOfficesForUser(username) {
  if (!username) throw new Error('[BolsaModule:getOfficesForUser] username is required.');
  return OfficesService.getOffices(username);
}

async function getMandoubs() {
  return AgentsService.getAllMandoubs();
}

const BolsaModule = Object.freeze({
  getOwners,
  getOfficesForUser,
  getMandoubs,
  saveBolsaForm: (username, payload) => BolsaFormsService.saveBolsaForm(username, payload),
  updateBolsaForm: (username, id, payload) => FinancialService.updateBolsaForm(username, id, payload),
  deleteBolsaForm: (username, id) => FinancialService.deleteBolsaForm(username, id),
});



// ========================================
// Bolsa Page — Rendering / Events
// ========================================

/**
 * bolsa-page.js
 * تفريغ البوالص — مصدر بيانات النقل.
 *
 * ملاحظة: هذه الصفحة لا تكتب مباشرة في DB إلا عبر BolsaFormsService.
 */



const COLS = [
  'رقم الكارتة', 'التاريخ', 'اسم السائق', 'صاحب المركبة', 'رقم المركبة',
  'وزن وش', 'اسم الشركة', 'التحميل', 'الجهة', 'النوع',
  'العهدة', 'اكرامية', 'نولون', 'سولار', 'ملاحظات', 'إجراءات',
];

const BOLSA_ARROW_ROW_ID = 'bolsaFillArrowRow';
const BOLSA_FILL_COLS = [
  'bolsa-karta',
  'bolsa-rowdate',
  'bolsa-driver',
  'bolsa-owner',
  'bolsa-car',
  'bolsa-weight',
  'bolsa-office',
  'bolsa-loading',
  'bolsa-direction',
  'bolsa-type',
  'bolsa-ohda',
  'bolsa-dokhan',
  'bolsa-noloon',
  'bolsa-solar',
  'bolsa-notes',
  null,
];

let _editingBolsaFormId = null;

const BOLSA_ENTER_NAV_ORDER = [
  'bolsa-karta',
  'bolsa-rowdate',
  'bolsa-driver',
  'bolsa-owner',
  'bolsa-car',
  'bolsa-weight',
  'bolsa-office',
  'bolsa-loading',
  'bolsa-direction',
  'bolsa-type',
  'bolsa-ohda',
  'bolsa-dokhan',
  'bolsa-noloon',
  'bolsa-solar',
];

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

function _todayISO() {
  return new Date().toISOString().split('T')[0];
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _fmt(n) {
  return Money.fmt(n);
}

function _rowEl(tag, attrs = {}, html = '') {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  });
  if (html) el.innerHTML = html;
  return el;
}

function _injectBolsaStyles() {
  if (document.getElementById('bolsa-module-styles')) return;
  const style = document.createElement('style');
  style.id = 'bolsa-module-styles';
  style.textContent = `
    .bolsa-arrow-cell {
      background: #0f766e;
      padding: 0;
      text-align: center;
      height: 28px;
    }
    .bolsa-arrow-cell--empty {
      background: #0f766e;
    }
    .bolsa-arrow-btn {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 26px;
      background: rgba(255,255,255,0.18);
      border: none;
      border-left: 1px solid rgba(255,255,255,0.25);
      color: #fff;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      transition: background 0.15s ease;
      line-height: 26px;
      padding: 0;
      text-align: center;
      font-family: inherit;
    }
    .bolsa-arrow-btn:hover {
      background: rgba(255,255,255,0.35);
    }
    .bolsa-arrow-btn:active {
      background: rgba(255,255,255,0.50);
    }
    .bolsa-cell-focused {
      outline: 2px solid #0d9488 !important;
      outline-offset: -1px;
      background: #ecfdf5 !important;
    }
  `;
  document.head.appendChild(style);
}

function _buildArrowRowHTML() {
  return BOLSA_FILL_COLS.map((cls, i) => {
    if (!cls) {
      return '<td class="bolsa-arrow-cell bolsa-arrow-cell--empty"></td>';
    }
    return `<td class="bolsa-arrow-cell">
      <button
        data-action="bolsa-fill-down"
        data-col-index="${i}"
        class="bolsa-arrow-btn"
        title="نسخ للأسفل"
        aria-label="نسخ للأسفل"
      >⬇</button>
    </td>`;
  }).join('');
}

function _ensureArrowRow() {
  const tbody = document.getElementById('bolsaTableBody');
  if (!tbody) return;
  if (tbody.querySelector('#' + BOLSA_ARROW_ROW_ID)) return;
  const row = document.createElement('tr');
  row.id = BOLSA_ARROW_ROW_ID;
  row.innerHTML = _buildArrowRowHTML();
  tbody.insertBefore(row, tbody.firstChild);
}

function _bolsaDataRows() {
  return [...document.querySelectorAll('#bolsaTableBody tr')]
    .filter(tr => tr.id !== BOLSA_ARROW_ROW_ID);
}

function _fillBolsaColumnDown(colIndex) {
  if (!BOLSA_FILL_COLS[colIndex]) return;
  const rows = _bolsaDataRows();
  if (rows.length < 2) return;

  // Find last row with a value in this column
  let sourceRowIdx = -1;
  let sourceVal = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    const cell = rows[i].querySelectorAll('td')[colIndex];
    const inp = cell?.querySelector('input, select, textarea');
    if (inp && String(inp.value).trim() !== '') {
      sourceRowIdx = i;
      sourceVal = inp.value;
      break;
    }
  }

  if (!sourceVal || sourceRowIdx === -1) return;

  // Copy to NEXT row only
  const nextIdx = sourceRowIdx + 1;
  if (nextIdx >= rows.length) return;

  const nextCell = rows[nextIdx].querySelectorAll('td')[colIndex];
  const nextInp = nextCell?.querySelector('input, select, textarea');
  if (nextInp) {
    nextInp.value = sourceVal;
    nextInp.dispatchEvent(new Event('input'));
  }
}

function _getBolsaNavigableInputs(row) {
  return [...row.querySelectorAll('input, select, textarea')].filter(el => {
    if (el.disabled || el.readOnly) return false;
    return true;
  });
}

function _focusBolsaVertical(currentRow, activeEl, direction) {
  const tbody = document.getElementById('bolsaTableBody');
  if (!tbody) return;

  const currentTd = activeEl.closest('td');
  if (!currentTd) return;
  const tdIdx = [...currentRow.querySelectorAll('td')].indexOf(currentTd);

  const allRows = _bolsaDataRows();
  const rowIdx = allRows.indexOf(currentRow);
  const targetRowIdx = rowIdx + direction;
  if (targetRowIdx < 0 || targetRowIdx >= allRows.length) return;

  const targetRow = allRows[targetRowIdx];
  const targetTd = [...targetRow.querySelectorAll('td')][tdIdx];
  if (!targetTd) return;

  const targetInput = targetTd.querySelector('input:not([readonly]), select:not([readonly]), textarea:not([readonly])');
  if (targetInput && !targetInput.disabled) targetInput.focus();
}

function _attachBolsaKeyboardNav(row) {
  if (!row) return;

  row.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    const activeEl = document.activeElement;
    if (!activeEl || !row.contains(activeEl)) return;

    const key = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(key)) return;

    if (key === 'Enter') {
      e.preventDefault();
      const currentClass = BOLSA_ENTER_NAV_ORDER.find(cls => activeEl.classList.contains(cls));
      const currentIdx = currentClass ? BOLSA_ENTER_NAV_ORDER.indexOf(currentClass) : -1;

      if (currentIdx !== -1 && currentIdx < BOLSA_ENTER_NAV_ORDER.length - 1) {
        const nextCls = BOLSA_ENTER_NAV_ORDER[currentIdx + 1];
        const nextEl = row.querySelector('.' + nextCls);
        if (nextEl && !nextEl.readOnly && !nextEl.disabled) {
          nextEl.focus();
          return;
        }
      }

      const allRows = _bolsaDataRows();
      const trIdx = allRows.indexOf(row);
      if (trIdx !== -1 && trIdx < allRows.length - 1) {
        const nextRow = allRows[trIdx + 1];
        const firstCls = BOLSA_ENTER_NAV_ORDER[0];
        const firstEl = nextRow.querySelector('.' + firstCls);
        if (firstEl) firstEl.focus();
      } else {
        _addRow();
        const all = _bolsaDataRows();
        const newRow = all[all.length - 1];
        const firstCls = BOLSA_ENTER_NAV_ORDER[0];
        const firstEl = newRow?.querySelector('.' + firstCls);
        if (firstEl) firstEl.focus();
      }
      return;
    }

    const inputs = _getBolsaNavigableInputs(row);
    const currentIdx = inputs.indexOf(activeEl);
    if (currentIdx === -1) return;

    if (key === 'ArrowRight') {
      e.preventDefault();
      const prevIdx = currentIdx - 1;
      if (prevIdx >= 0) inputs[prevIdx].focus();
    } else if (key === 'ArrowLeft') {
      e.preventDefault();
      const nextIdx = currentIdx + 1;
      if (nextIdx < inputs.length) inputs[nextIdx].focus();
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      _focusBolsaVertical(row, activeEl, -1);
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      _focusBolsaVertical(row, activeEl, 1);
    }
  });
}

function _render() {
  const page = document.getElementById('bolsaPage');
  if (!page) return;

  page.innerHTML = `
    <div class="bg-white rounded-t-xl shadow-lg p-6 pb-0"></div>

    <div class="bg-white shadow-lg p-6 pt-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-xl font-bold text-gray-800">جدول البوالص</h3>
        <div style="display:flex; gap:16px; align-items:flex-end;">
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1" for="bolsaDate">التاريخ</label>
            <input id="bolsaDate" type="date"
              class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
            <div id="bolsaDateMsg" class="field-msg-inline field-msg-inline--error" role="alert"></div>
          </div>
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1" for="bolsaAgent">اسم المندوب</label>
            <select id="bolsaAgent"
              class="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 outline-none bg-white">
              <option value="">— اختر المندوب —</option>
            </select>
            <div id="bolsaAgentMsg" class="field-msg-inline field-msg-inline--error" role="alert"></div>
          </div>
        </div>
        <div class="flex gap-2">
          <button type="button" data-action="bolsa-add-row"
            class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
            </svg>
            إضافة صف
          </button>
          <button type="button" data-action="bolsa-add-4-rows"
            class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
            </svg>
            إضافة 4 صفوف
          </button>
        </div>
      </div>

      <div id="bolsaTopError" class="hidden mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-300 text-red-700 text-sm" role="alert"></div>

      <datalist id="bolsaOwnersList"></datalist>
      <datalist id="bolsaOfficesList"></datalist>

      <div style="overflow-x:auto; overflow-y:auto; max-height:65vh; width:100%;">
        <table class="text-xs" id="bolsaTable"
          style="table-layout:auto; width:100%; border-collapse:collapse;">
          <thead style="background: linear-gradient(to right, #0f766e, #0d9488); position:sticky; top:0; z-index:10;" class="text-white">
            <tr>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:50px;font-size:10px;">رقم الكارتة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:55px;font-size:10px;">التاريخ</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:70px;font-size:10px;">اسم السائق</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:80px;font-size:10px;">صاحب المركبة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">رقم المركبة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:50px;font-size:10px;">وزن وش</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:80px;font-size:10px;">اسم الشركة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:80px;font-size:10px;">التحميل</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:80px;font-size:10px;">الجهة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">النوع</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">العهدة</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">اكرامية</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">نولون</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:45px;font-size:10px;">سولار</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:70px;font-size:10px;">ملاحظات</th>
              <th class="px-1 py-1 text-center whitespace-nowrap" style="min-width:30px;font-size:10px;">حذف</th>
            </tr>
          </thead>
          <tbody id="bolsaTableBody"></tbody>
        </table>
      </div>

      <!-- إجماليات البوالص -->
      <div id="bolsaTotalsContainer" class="flex flex-nowrap gap-2 pb-2 mt-4">
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#6b7280,#4b5563)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">عدد الصفوف</p>
          <p class="text-xl font-bold" style="color:#fff" id="bolsaRowCount">0</p>
        </div>
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#0f766e,#0d9488)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">إجمالي الوزن</p>
          <p class="text-xl font-bold" style="color:#fff" id="bolsaTotalWeight">0.00</p>
        </div>
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#f97316,#ea580c)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">إجمالي الإكرامية</p>
          <p class="text-xl font-bold" style="color:#fff" id="bolsaTotalDokhan">0.00</p>
        </div>
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#16a34a,#15803d)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">إضافة</p>
          <input type="number" id="bolsaAddition" value="0" min="0" step="0.01"
            style="width:100%;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:6px;padding:3px 6px;font-size:15px;font-weight:bold;color:white;text-align:center;box-sizing:border-box;">
        </div>
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#dc2626,#b91c1c)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">الإجمالي الكلي</p>
          <p class="text-xl font-bold" style="color:#fff" id="bolsaGrandTotal">0.00</p>
        </div>
        <div class="flex-1 min-w-[90px] p-3 rounded-lg text-white" style="background:linear-gradient(135deg,#0ea5e9,#0284c7)">
          <p class="text-xs opacity-90 mb-1" style="color:#fff">إجمالي السولار</p>
          <p class="text-xl font-bold" style="color:#fff" id="bolsaTotalSolar">0.00</p>
        </div>
      </div>

      <!-- أزرار الحفظ السفلية -->
      <div class="flex flex-wrap gap-3 mt-6">
        <button id="bolsaSaveBtn" type="button" data-action="bolsa-save"
          style="background: linear-gradient(to right, #0f766e, #0d9488);"
          class="hover:shadow-lg text-white px-8 py-3 rounded-lg transition flex items-center gap-2 font-semibold">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path>
          </svg>
          حفظ النموذج
        </button>
        <button id="cancelBolsaEditBtn" type="button" data-action="bolsa-cancel-edit"
          class="hidden bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-3 rounded-lg transition flex items-center gap-2">
          إلغاء التعديل
        </button>
        <button type="button" data-action="bolsa-add-row"
          class="bg-green-600 hover:bg-green-700 text-white px-4 py-3 rounded-lg transition flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
          إضافة صف
        </button>
        <button type="button" data-action="bolsa-add-4-rows"
          class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-lg transition flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
          إضافة 4 صفوف
        </button>
        <button type="button" data-action="bolsa-export-excel"
          class="bg-teal-700 hover:bg-teal-800 text-white px-4 py-3 rounded-lg transition flex items-center gap-2"
          title="تصدير صفوف البوالص إلى Excel">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          📤 تصدير Excel
        </button>
        <button type="button" data-action="bolsa-import-excel"
          class="bg-violet-600 hover:bg-violet-700 text-white px-4 py-3 rounded-lg transition flex items-center gap-2"
          title="استيراد صفوف من Excel">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0l-4 4m4-4v12"/>
          </svg>
          📥 استيراد Excel
        </button>
      </div>
    </div>
  `;
}

function _rowTemplate() {
  const inp = (cls, extra = '') =>
    `<input class="${cls} w-full px-1 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-teal-500 outline-none" ${extra}>`;

  const msgErr = key =>
    `<div class="row-msg row-msg-${key} field-msg-inline field-msg-inline--error" role="alert"></div>`;

  return `
    <td class="px-1 py-1" style="min-width:50px;">
      ${inp('bolsa-karta', 'type="text"')}
      ${msgErr('karta')}
      ${msgErr('karta-dup')}
    </td>
    <td class="px-1 py-1" style="min-width:55px;">
      ${inp('bolsa-rowdate', 'type="text" placeholder="يوم/شهر"')}
    </td>
    <td class="px-1 py-1" style="min-width:70px;">
      ${inp('bolsa-driver', 'type="text"')}
    </td>
    <td class="px-1 py-1" style="min-width:80px;">
      ${inp('bolsa-owner', 'type="text" list="bolsaOwnersList" placeholder="صاحب المركبة"')}
      ${msgErr('owner')}
      <div class="row-msg row-msg-owner-exists field-msg-inline field-msg-inline--warn" role="status"></div>
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-car', 'type="text"')}
    </td>
    <td class="px-1 py-1" style="min-width:50px;">
      ${inp('bolsa-weight', 'type="number" step="0.01" min="0"')}
    </td>
    <td class="px-1 py-1" style="min-width:80px;">
      ${inp('bolsa-office', 'type="text" list="bolsaOfficesList" placeholder="الشركة"')}
    </td>
    <td class="px-1 py-1" style="min-width:80px;">
      ${inp('bolsa-loading', 'type="text"')}
    </td>
    <td class="px-1 py-1" style="min-width:80px;">
      ${inp('bolsa-direction', 'type="text"')}
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-type', 'type="text"')}
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-ohda', 'type="number" step="0.01" min="0"')}
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-dokhan', 'type="number" step="0.01" min="0"')}
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-noloon', 'type="number" step="0.01" min="0" value="0"')}
    </td>
    <td class="px-1 py-1" style="min-width:45px;">
      ${inp('bolsa-solar', 'type="number" step="0.01" min="0" value="0"')}
    </td>
    <td class="px-1 py-1" style="min-width:70px;">
      ${inp('bolsa-notes', 'type="text"')}
    </td>
    <td class="px-1 py-1 text-center" style="min-width:30px;">
      <button type="button" data-action="bolsa-remove-row"
        class="text-red-600 hover:text-red-800 transition" aria-label="حذف الصف">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
        </svg>
      </button>
    </td>
  `;
}

function _setMsg(tr, key, text, kind = 'error') {
  const el = tr?.querySelector(`.row-msg-${key}`);
  if (!el) return;
  el.classList.remove('field-msg-inline--error', 'field-msg-inline--warn');
  el.classList.add(kind === 'warning' ? 'field-msg-inline--warn' : 'field-msg-inline--error');
  el.textContent = text || '';
  el.classList.toggle('is-visible', Boolean(text));
}

function _collectRow(tr) {
  const v = (cls) => tr.querySelector('.' + cls)?.value ?? '';
  // Phase 2 TASK G — preserve legacy weight2.
  // The weight2 column was removed from the UI but legacy records may
  // still carry a non-zero value.  We stash it on the <tr> during
  // hydration (see _hydrateBolsaRows) and read it back here so editing
  // a legacy bolsa never silently zeroes the historical weight2.
  // For fresh rows tr.dataset.legacyWeight2 is undefined → defaults to 0.
  const legacyW2 = Number(tr.dataset.legacyWeight2);
  const weight2  = Number.isFinite(legacyW2) ? legacyW2 : 0;

  return {
    kartaNo: String(v('bolsa-karta')).trim(),
    rowdate: String(v('bolsa-rowdate')).trim(),
    driver: String(v('bolsa-driver')).trim(),
    owner_name: String(v('bolsa-owner')).trim(),
    carNo: String(v('bolsa-car')).trim(),
    weight: _num(v('bolsa-weight')),
    weight2,
    office: String(v('bolsa-office')).trim(),
    loading: String(v('bolsa-loading')).trim(),
    direction: String(v('bolsa-direction')).trim(),
    type: String(v('bolsa-type')).trim(),
    ohda: _num(v('bolsa-ohda')),
    dokhan: _num(v('bolsa-dokhan')),
    noloon: _num(v('bolsa-noloon')),
    solar: _num(v('bolsa-solar')),
    notes: String(v('bolsa-notes')).trim(),
  };
}

function _recalcTotals() {
  const trs = _bolsaDataRows();
  let ohda = 0;
  let dokhan = 0;
  let totalWeight = 0;
  let totalSolar = 0;
  trs.forEach(tr => {
    ohda       += _num(tr.querySelector('.bolsa-ohda')?.value);
    dokhan     += _num(tr.querySelector('.bolsa-dokhan')?.value);
    totalWeight += _num(tr.querySelector('.bolsa-weight')?.value);
    totalSolar += _num(tr.querySelector('.bolsa-solar')?.value);
  });

  const rc  = document.getElementById('bolsaRowCount');
  const tw  = document.getElementById('bolsaTotalWeight');
  const dk  = document.getElementById('bolsaTotalDokhan');
  const so  = document.getElementById('bolsaTotalSolar');
  const gt  = document.getElementById('bolsaGrandTotal');
  const addEl = document.getElementById('bolsaAddition');
  const addition = parseFloat(addEl?.value) || 0;

  const grandTotal = ohda + dokhan + addition;

  if (rc)  rc.textContent  = trs.length;
  if (tw)  tw.textContent  = _fmt(totalWeight);
  if (dk)  dk.textContent  = _fmt(dokhan);
  if (so)  so.textContent  = _fmt(totalSolar);
  if (gt)  gt.textContent  = _fmt(grandTotal);
}

function _highlightDuplicateKartas() {
  const trs = _bolsaDataRows();
  const counts = new Map();
  trs.forEach(tr => {
    const k = String(tr.querySelector('.bolsa-karta')?.value || '').trim();
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  trs.forEach(tr => {
    const inp = tr.querySelector('.bolsa-karta');
    const k = String(inp?.value || '').trim();
    const dup = k && (counts.get(k) || 0) > 1;
    if (inp) inp.classList.toggle('input-error', dup);
    _setMsg(tr, 'karta-dup', dup ? '❌ رقم الكارتة مكرر داخل الجدول' : '', 'error');
  });
}

/**
 * Per-row counter used to generate STABLE, UNIQUE datalist IDs.
 *
 * Each row gets its own pair of datalist IDs the FIRST time _bindRowOffice
 * needs them.  The IDs are stored on the <tr> as dataset.dlLoadId /
 * dataset.dlDirId so subsequent office changes reuse the same elements
 * instead of creating new ones.
 *
 * No Date.now()/Math.random() spam, no DOM growth, no orphan datalists.
 */
let _bolsaRowDatalistCounter = 0;

/**
 * _bindRowOffice(tr) — Phase 2 rewrite (TASK A).
 *
 * Wires the office input to populate the row's loading + direction
 * datalists from the chosen office's hamolaRows, then auto-fills
 * noloon + type when the user picks a loading/direction combo that
 * matches a hamola entry.
 *
 * KEY DESIGN POINTS:
 *   1. The two datalists (loading + direction) are created ONCE per row,
 *      lazily on first office change.  IDs are stable
 *      (`bolsa_dl_loading_<n>` / `bolsa_dl_dir_<n>`).  Re-attaching
 *      `list=` on the input is idempotent.
 *   2. The autoFill listeners on loading + direction inputs are attached
 *      ONCE per row.  Marked with tr.dataset.officeBound='1'.
 *   3. The office change listener on this tr is attached ONCE per row.
 *      Marked with tr.dataset.officeListenerBound='1' so a future call
 *      to _bindRowOffice on the same tr (currently impossible but
 *      defensive) is a no-op.
 *   4. The fresh hamola data is stored on tr._hamolaData and the
 *      autoFill closure reads it from there every time, so a later
 *      office change correctly re-targets the autoFill logic without
 *      re-attaching listeners.
 */
function _bindRowOffice(tr) {
  const officeInp    = tr.querySelector('.bolsa-office');
  const loadingInp   = tr.querySelector('.bolsa-loading');
  const directionInp = tr.querySelector('.bolsa-direction');
  if (!officeInp || !loadingInp || !directionInp) return;

  // ── Guard: ensure office change handler is attached exactly once ──────
  if (tr.dataset.officeListenerBound === '1') return;
  tr.dataset.officeListenerBound = '1';

  // ── Per-row stable hamola data slot (mutable; refreshed on every
  //    office change so the autoFill closure always sees current data) ─
  tr._hamolaData = [];

  // ── Lazy datalist factory: create exactly one pair per row ───────────
  function _ensureRowDatalists() {
    if (tr.dataset.dlLoadId && tr.dataset.dlDirId) {
      // Already created; reuse them.
      return {
        dlLoad: document.getElementById(tr.dataset.dlLoadId),
        dlDir:  document.getElementById(tr.dataset.dlDirId),
      };
    }

    const n = ++_bolsaRowDatalistCounter;
    const dlLoadId = `bolsa_dl_loading_${n}`;
    const dlDirId  = `bolsa_dl_dir_${n}`;

    const dlLoad = document.createElement('datalist');
    dlLoad.id = dlLoadId;
    document.body.appendChild(dlLoad);

    const dlDir = document.createElement('datalist');
    dlDir.id = dlDirId;
    document.body.appendChild(dlDir);

    tr.dataset.dlLoadId = dlLoadId;
    tr.dataset.dlDirId  = dlDirId;

    // Bind input to its datalist exactly once.
    loadingInp.setAttribute('list', dlLoadId);
    directionInp.setAttribute('list', dlDirId);

    return { dlLoad, dlDir };
  }

  // ── autoFill: pure function reading from tr._hamolaData (live slot) ──
  function _autoFill() {
    const hamola = Array.isArray(tr._hamolaData) ? tr._hamolaData : [];
    if (hamola.length === 0) return;

    const loadVal = String(loadingInp.value || '').trim();
    const dirVal  = String(directionInp.value || '').trim();
    if (!loadVal || !dirVal) return;

    const match = hamola.find(h =>
      String(h.loading_place || h.loading || '').trim() === loadVal
      && String(h.destination_place || h.direction || h.taktik || '').trim() === dirVal
    );
    if (!match) return;

    const noloonInp = tr.querySelector('.bolsa-noloon');
    const noloonVal = Number(match.nolon ?? match.noloon);
    if (noloonInp && Number.isFinite(noloonVal)) {
      noloonInp.value = String(noloonVal);
    }

    const typeVal = String(match.item_type ?? match.type ?? '').trim();
    const typeInp = tr.querySelector('.bolsa-type');
    if (typeInp && typeVal) {
      typeInp.value = typeVal;
    }

    _recalcTotals();
  }

  // ── Office change → refresh datalists + hamola data slot (no new listeners) ──
  officeInp.addEventListener('change', async () => {
    let username;
    try { username = _currentUsername(); } catch (_) { return; }
    const officeName = String(officeInp.value || '').trim();
    if (!username || !officeName) {
      // Clear datalists if office was cleared.
      const dls = _ensureRowDatalists();
      dls.dlLoad.innerHTML = '';
      dls.dlDir.innerHTML  = '';
      tr._hamolaData = [];
      return;
    }

    const offices = await BolsaModule.getOfficesForUser(username);
    const office  = offices.find(o => String(o.name || '').trim() === officeName);
    const hamola  = Array.isArray(office?.hamolaRows) ? office.hamolaRows : [];

    const loadVals = [...new Set(
      hamola.map(r => String(r.loading_place || r.loading || '').trim()).filter(Boolean)
    )];
    const dirVals = [...new Set(
      hamola.map(r => String(r.destination_place || r.direction || r.taktik || '').trim()).filter(Boolean)
    )];

    const { dlLoad, dlDir } = _ensureRowDatalists();
    dlLoad.innerHTML = loadVals.map(v => `<option value="${v}"></option>`).join('');
    dlDir.innerHTML  = dirVals.map(v => `<option value="${v}"></option>`).join('');

    // Refresh the live hamola slot — autoFill reads from this slot.
    tr._hamolaData = hamola;

    // Attach autoFill listeners EXACTLY ONCE per row.
    if (tr.dataset.autoFillBound !== '1') {
      tr.dataset.autoFillBound = '1';
      loadingInp.addEventListener('change',  _autoFill);
      directionInp.addEventListener('change', _autoFill);
    }
  });
}


// ─── OWNER ↔ CAR LINKING (Bolsa) ──────────────────────────────────────────────

async function _bolsaLinkCarToOwner(tr) {
  const carInput = tr.querySelector('.bolsa-car');
  const ownerInput = tr.querySelector('.bolsa-owner');
  const driverInput = tr.querySelector('.bolsa-driver');
  if (!carInput || !ownerInput) return;
  const plate = (carInput.value || '').trim();
  if (!plate) return;

  const vehicles = await DB.findByFields('vehicles', { plate });
  if (vehicles.length === 0) return;

  if (vehicles.length === 1) {
    const v = vehicles[0];
    if (v.owner_name && !ownerInput.value.trim()) {
      ownerInput.value = v.owner_name;
    }
    // Auto-fill driver from vehicle
    if (driverInput && v.driver_name && !driverInput.value.trim()) {
      driverInput.value = v.driver_name;
    }
  } else {
    const names = [...new Set(vehicles.map(v => v.owner_name).filter(Boolean))];
    if (names.length > 0) {
      let dl = tr.querySelector('.bolsa-row-owners-dl');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.className = 'bolsa-row-owners-dl';
        dl.id = 'bolsaRowOwnersDL_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        ownerInput.parentElement.appendChild(dl);
        ownerInput.setAttribute('list', dl.id);
      }
      dl.innerHTML = names.map(n => `<option value="${n}"></option>`).join('');
    }
  }
}

async function _bolsaLinkOwnerToCar(tr) {
  const ownerInput = tr.querySelector('.bolsa-owner');
  const carInput = tr.querySelector('.bolsa-car');
  const driverInput = tr.querySelector('.bolsa-driver');
  if (!ownerInput || !carInput) return;
  const ownerName = (ownerInput.value || '').trim();
  if (!ownerName) return;

  // TASK D — scope owner lookup to current tenant.
  let username;
  try { username = _currentUsername(); } catch (_) { return; }
  const owners = await BolsaModule.getOwners(username);
  const owner = owners.find(o => o.name === ownerName);
  if (!owner) return;

  const allVehicles = await DB.getAll('vehicles');
  const ownerVehicles = allVehicles.filter(v => String(v.owner_id || '') === String(owner.id));

  // ── Vehicle linking ──
  if (ownerVehicles.length === 1 && !carInput.value.trim()) {
    carInput.value = ownerVehicles[0].plate || '';
  } else if (ownerVehicles.length > 1) {
    let dl = tr.querySelector('.bolsa-row-cars-dl');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.className = 'bolsa-row-cars-dl';
      dl.id = 'bolsaRowCarsDL_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      carInput.parentElement.appendChild(dl);
      carInput.setAttribute('list', dl.id);
    }
    dl.innerHTML = ownerVehicles.map(v => `<option value="${v.plate}"></option>`).join('');
  }

  // ── Driver linking ──
  if (driverInput) {
    const drivers = ownerVehicles
      .map(v => v.driver_name)
      .filter(Boolean);
    const uniqueDrivers = [...new Set(drivers)];

    if (uniqueDrivers.length === 1 && !driverInput.value.trim()) {
      driverInput.value = uniqueDrivers[0];
    } else if (uniqueDrivers.length > 1) {
      let dl = tr.querySelector('.bolsa-row-drivers-dl');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.className = 'bolsa-row-drivers-dl';
        dl.id = 'bolsaRowDriversDL_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        driverInput.parentElement.appendChild(dl);
        driverInput.setAttribute('list', dl.id);
      }
      dl.innerHTML = uniqueDrivers.map(d => `<option value="${d}"></option>`).join('');
    }
  }
}

function _addRow() {
  const tbody = document.getElementById('bolsaTableBody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.className = 'border-b border-gray-200 hover:bg-gray-50';
  tr.innerHTML = _rowTemplate();
  tbody.appendChild(tr);

  // Set default date from main date field
  const mainDate = document.getElementById('bolsaDate')?.value || '';
  const dateInp = tr.querySelector('.bolsa-rowdate');
  if (dateInp && mainDate && !dateInp.value) {
    // Format: extract day/month from ISO date
    const parts = mainDate.split('-');
    if (parts.length === 3) {
      dateInp.value = parts[2] + '/' + parts[1];
    }
  }

  // per-row listeners
  tr.querySelector('.bolsa-karta')?.addEventListener('input', () => {
    _setMsg(tr, 'karta', '', 'error');
    _highlightDuplicateKartas();
  });
  tr.querySelector('.bolsa-owner')?.addEventListener('input', () => {
    _setMsg(tr, 'owner', '', 'error');
    const oex = tr.querySelector('.row-msg-owner-exists');
    if (oex) { oex.textContent = ''; oex.classList.remove('is-visible'); }
  });

  // Owner ↔ Car linking
  tr.querySelector('.bolsa-car')?.addEventListener('change', () => _bolsaLinkCarToOwner(tr));
  // Save driver to vehicle when changed
  tr.querySelector('.bolsa-driver')?.addEventListener('change', async () => {
    const plate = (tr.querySelector('.bolsa-car')?.value || '').trim();
    const driver = (tr.querySelector('.bolsa-driver')?.value || '').trim();
    if (plate && driver) {
      try {
        const vehicles = await DB.findByFields('vehicles', { plate });
        if (vehicles[0] && !vehicles[0].driver_name) {
          await DB.update('vehicles', vehicles[0].id, { driver_name: driver }, { username: _currentUsername() });
        }
      } catch(_) {}
    }
  });
  tr.querySelector('.bolsa-owner')?.addEventListener('change', () => _bolsaLinkOwnerToCar(tr));

  ['bolsa-weight', 'bolsa-ohda', 'bolsa-dokhan', 'bolsa-solar'].forEach(cls => {
    tr.querySelector('.' + cls)?.addEventListener('input', () => {
      _recalcTotals();
    });
  });

  _bindRowOffice(tr);
  _attachBolsaKeyboardNav(tr);
  _ensureArrowRow();
  _recalcTotals();
  _highlightDuplicateKartas();
}

async function _loadOwnersDatalist() {
  const list = document.getElementById('bolsaOwnersList');
  if (!list) return;
  // TASK D — scope datalist source to current tenant.
  // getByIndex already filters out soft-deleted records, so the extra
  // .filter(deleted_at === null) is no longer needed.
  let username;
  try { username = _currentUsername(); } catch (_) { list.innerHTML = ''; return; }
  const owners = await BolsaModule.getOwners(username);
  list.innerHTML = owners
    .map(o => `<option value="${o.name || ''}"></option>`)
    .join('');
}

async function _loadOfficesDatalist() {
  const list = document.getElementById('bolsaOfficesList');
  if (!list) return;
  const username = _currentUsername();
  if (!username) return;
  const offices = await BolsaModule.getOfficesForUser(username);
  list.innerHTML = offices.map(o => `<option value="${o.name || ''}"></option>`).join('');
}

async function _loadMandoubsSelect() {
  const sel = document.getElementById('bolsaAgent');
  if (!sel) return;
  const mandoubs = await BolsaModule.getMandoubs();
  const options = mandoubs.map(a => `<option value="${String(a.id)}">${a.name || '—'}</option>`).join('');
  // keep placeholder
  sel.innerHTML = `<option value="">— اختر المندوب —</option>` + options;
}

function _topError(text) {
  const el = document.getElementById('bolsaTopError');
  if (!el) return;
  if (!text) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

function _setBolsaSaveMode(isEditing) {
  const saveBtn = document.getElementById('bolsaSaveBtn');
  const cancelBtn = document.getElementById('cancelBolsaEditBtn');
  if (saveBtn) saveBtn.textContent = isEditing ? 'حفظ التعديلات' : 'حفظ النموذج';
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !isEditing);
}

function _clearBolsaRows() {
  const tbody = document.getElementById('bolsaTableBody');
  if (tbody) tbody.innerHTML = '';
}

function _hydrateBolsaRows(rows) {
  _clearBolsaRows();
  const list = Array.isArray(rows) ? rows : [];
  for (const rowData of list) {
    _addRow();
    const tr = _bolsaDataRows().at(-1);
    if (!tr) continue;
    const set = (cls, value) => {
      const el = tr.querySelector('.' + cls);
      if (el) el.value = value ?? '';
    };
    set('bolsa-karta', rowData.kartaNo);
    set('bolsa-rowdate', rowData.rowdate);
    set('bolsa-driver', rowData.driver);
    set('bolsa-owner', rowData.owner_name);
    set('bolsa-car', rowData.carNo);
    set('bolsa-weight', rowData.weight);
    // Phase 2 TASK G — preserve legacy weight2 across an edit→save cycle.
    // The weight2 column was removed from the editable table, so we stash
    // the historical value on the <tr> as data-legacy-weight2.  _collectRow
    // reads it back on save so the value isn't silently zeroed.
    // For fresh records this is undefined → defaults to 0 (no behavior change).
    const legacyW2 = Number(rowData.weight2);
    if (Number.isFinite(legacyW2) && legacyW2 !== 0) {
      tr.dataset.legacyWeight2 = String(legacyW2);
    }
    set('bolsa-office', rowData.office);
    set('bolsa-loading', rowData.loading);
    set('bolsa-direction', rowData.direction);
    set('bolsa-type', rowData.type);
    set('bolsa-ohda', rowData.ohda);
    set('bolsa-dokhan', rowData.dokhan);
    set('bolsa-noloon', rowData.noloon);
    set('bolsa-solar', rowData.solar);
    set('bolsa-notes', rowData.notes);
  }
}

async function loadBolsaForEdit(formData) {
  if (!formData?.id) throw new Error('❌ بيانات البوليصة غير صحيحة');
  _editingBolsaFormId = String(formData.id);
  const dateEl = document.getElementById('bolsaDate');
  const agentEl = document.getElementById('bolsaAgent');
  if (dateEl) dateEl.value = formData.bolsa_date || '';
  if (agentEl) agentEl.value = String(formData.agent_id || '');
  _hydrateBolsaRows(formData.rows || []);
  _ensureArrowRow();
  // Restore addition value
  const addEl = document.getElementById('bolsaAddition');
  if (addEl) addEl.value = formData.totals?.addition ?? formData.addition ?? 0;
  _recalcTotals();
  _highlightDuplicateKartas();
  _setBolsaSaveMode(true);
  _topError(null);
}

function cancelBolsaEdit() {
  _editingBolsaFormId = null;
  _setBolsaSaveMode(false);
}

async function _validateInline() {
  let ok = true;
  const dateEl = document.getElementById('bolsaDate');
  const agentEl = document.getElementById('bolsaAgent');

  const dateMsg = document.getElementById('bolsaDateMsg');
  const agentMsg = document.getElementById('bolsaAgentMsg');
  if (dateMsg) { dateMsg.textContent = ''; dateMsg.classList.remove('is-visible'); }
  if (agentMsg) { agentMsg.textContent = ''; agentMsg.classList.remove('is-visible'); }

  const date = String(dateEl?.value || '').trim();
  const agent_id = String(agentEl?.value || '').trim();

  if (!date) {
    ok = false;
    if (dateMsg) { dateMsg.textContent = '❌ التاريخ مطلوب'; dateMsg.classList.add('is-visible'); }
  }
  if (!agent_id) {
    ok = false;
    if (agentMsg) { agentMsg.textContent = '❌ يجب اختيار المندوب'; agentMsg.classList.add('is-visible'); }
  }

  const trs = [...document.querySelectorAll('#bolsaTableBody tr')];
  const dataRows = _bolsaDataRows();
  if (dataRows.length === 0) {
    _topError('❌ يجب إضافة صف واحد على الأقل');
    return false;
  }

  _topError(null);

  // per-row required fields
  for (const tr of dataRows) {
    const karta = String(tr.querySelector('.bolsa-karta')?.value || '').trim();
    const owner = String(tr.querySelector('.bolsa-owner')?.value || '').trim();
    _setMsg(tr, 'karta', karta ? '' : '❌ رقم الكارتة مطلوب', 'error');
    _setMsg(tr, 'owner', owner ? '' : '❌ اسم صاحب المركبة مطلوب', 'error');
    if (!karta || !owner) ok = false;
  }

  _highlightDuplicateKartas();
  const hasDup = [...document.querySelectorAll('#bolsaTableBody .row-msg-karta-dup')].some(el => el.classList.contains('is-visible'));
  if (hasDup) ok = false;

  return ok;
}

async function _save() {
  const ok = await _validateInline();
  if (!ok) return;

  const username = _currentUsername();
  if (!username) {
    _topError('❌ لا يمكن الحفظ بدون مستخدم');
    return;
  }

  const bolsa_date = String(document.getElementById('bolsaDate')?.value || '').trim();
  const agent_id = String(document.getElementById('bolsaAgent')?.value || '').trim();

  const trs = _bolsaDataRows();
  const rows = trs.map(_collectRow).map(r => ({
    ...r,
    used_in_receipt: false,
    used_receipt_id: null,
  }));

  const addition = parseFloat(document.getElementById('bolsaAddition')?.value) || 0;

  try {
    if (_editingBolsaFormId) {
      await BolsaModule.updateBolsaForm(username, _editingBolsaFormId, { bolsa_date, agent_id, rows, addition });
      _editingBolsaFormId = null;
      _setBolsaSaveMode(false);
    } else {
      await BolsaModule.saveBolsaForm(username, { bolsa_date, agent_id, rows, addition });
    }
    _topError(null);
    // reset UI
    _clearBolsaRows();
    _addRow();
    const addEl = document.getElementById('bolsaAddition');
    if (addEl) addEl.value = '0';
    _recalcTotals();
    // NOTE: bolsaForms:changed / agents:changed are dispatched by
    // FinancialService.createBolsaForm / updateBolsaForm after the DB
    // transaction commits.  Per the service-owned events architecture
    // rule, callers must not dispatch these events again here.
  } catch (err) {
    console.error('[bolsa] save failed:', err);
    _topError(err?.message || '❌ حدث خطأ أثناء حفظ النموذج');
  }
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Collects current bolsa table rows as plain objects and exports to Excel.
 * DOM read is valid here: the form has not been saved yet.
 */
function _handleBolsaExcelExport() {
  const trs = _bolsaDataRows();

  if (trs.length === 0) {
    alert('لا توجد صفوف بيانات للتصدير.');
    return;
  }

  const rows = trs.map(tr => _collectRow(tr));

  try {
    ExcelService.exportBolsaRows(rows);
  } catch (err) {
    console.error('[bolsas] Excel export failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

/**
 * Opens a file picker, imports bolsa rows from Excel, then fills the form.
 * Appends imported rows to any existing rows in the table.
 */
function _handleBolsaExcelImport() {
  ExcelService.openFilePicker(async (file) => {
    try {
      const importedRows = await ExcelService.importBolsaRows(file);

      for (const rowData of importedRows) {
        _addRow();
        const trs = _bolsaDataRows();
        const tr  = trs[trs.length - 1];
        if (!tr) continue;

        const setVal = (cls, val) => {
          const el = tr.querySelector('.' + cls);
          if (el) el.value = val ?? '';
        };

        setVal('bolsa-karta',     rowData.kartaNo    ?? '');
        // BUG #3 fix: only overwrite the date when the Excel cell is non-empty.
        // _addRow() already fills a default date from the main date field;
        // setting an empty string here would erase that default.
        if (rowData.rowdate) setVal('bolsa-rowdate', rowData.rowdate);
        setVal('bolsa-driver',    rowData.driver     ?? '');
        setVal('bolsa-owner',     rowData.owner_name ?? '');
        setVal('bolsa-car',       rowData.carNo      ?? '');
        setVal('bolsa-weight',    rowData.weight  !== 0 ? rowData.weight  : '');
        setVal('bolsa-office',    rowData.office     ?? '');
        setVal('bolsa-loading',   rowData.loading    ?? '');
        setVal('bolsa-direction', rowData.direction  ?? '');
        setVal('bolsa-type',      rowData.type       ?? '');
        setVal('bolsa-ohda',      rowData.ohda    !== 0 ? rowData.ohda    : '');
        setVal('bolsa-dokhan',    rowData.dokhan  !== 0 ? rowData.dokhan  : '');
        setVal('bolsa-noloon',    rowData.noloon  !== 0 ? rowData.noloon  : '');
        setVal('bolsa-solar',     rowData.solar   !== 0 ? rowData.solar   : '');
        setVal('bolsa-notes',     rowData.notes      ?? '');
      }

      _recalcTotals();
      alert(`✅ تم استيراد ${importedRows.length} صف بنجاح.`);
    } catch (err) {
      console.error('[bolsas] Excel import failed:', err);
      alert(err.message || '❌ فشل استيراد Excel');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function initBolsaPage() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }

  const page = document.getElementById('bolsaPage');
  if (!page) return;

  _render();
  _injectBolsaStyles();

  const dateEl = document.getElementById('bolsaDate');
  if (dateEl) dateEl.value = _todayISO();
  _setBolsaSaveMode(false);

  _loadOwnersDatalist();
  _loadOfficesDatalist();
  _loadMandoubsSelect();

  // seed first row
  _addRow();

  // Addition input listener
  document.addEventListener('input', (e) => {
    if (e.target.id === 'bolsaAddition') _recalcTotals();
  });

  // delegated actions
  document.addEventListener('click', (e) => {
    const fillBtn = e.target.closest('[data-action="bolsa-fill-down"]');
    if (fillBtn) {
      const idx = Number(fillBtn.dataset.colIndex);
      if (!Number.isNaN(idx)) _fillBolsaColumnDown(idx);
      return;
    }
    if (e.target.closest('[data-action="bolsa-add-row"]')) {
      _addRow();
      return;
    }
    if (e.target.closest('[data-action="bolsa-add-4-rows"]')) {
      _addRow(); _addRow(); _addRow(); _addRow();
      return;
    }
    if (e.target.closest('[data-action="bolsa-export-excel"]')) {
      _handleBolsaExcelExport();
      return;
    }
    if (e.target.closest('[data-action="bolsa-import-excel"]')) {
      _handleBolsaExcelImport();
      return;
    }
    if (e.target.closest('[data-action="bolsa-save"]')) {
      _save();
      return;
    }
    if (e.target.closest('[data-action="bolsa-cancel-edit"]')) {
      cancelBolsaEdit();
      _clearBolsaRows();
      _addRow();
      _recalcTotals();
      return;
    }
    const rm = e.target.closest('[data-action="bolsa-remove-row"]');
    if (rm) {
      rm.closest('tr')?.remove();
      _recalcTotals();
      _highlightDuplicateKartas();
    }
  });

  window.addEventListener('owners:changed', () => _loadOwnersDatalist());
  window.addEventListener('agents:changed', () => _loadMandoubsSelect());
  window.addEventListener('offices:changed', () => _loadOfficesDatalist());

  // Auto-select input value on focus (same as receipt page)
  document.addEventListener('focusin', function(e) {
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return;
    if (!el.closest('#bolsaTableBody')) return;
    setTimeout(function() { try { el.select(); } catch(_) {} }, 0);
  });
}


// ========================================
// Public API
// ========================================

export { BolsaFormsService, BolsaModule, initBolsaPage, loadBolsaForEdit, cancelBolsaEdit };
