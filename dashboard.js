/**
 * dashboard.js — لوحة التحكم / Dashboard العميل
 * Completely isolated from core financial operations, read-only to existing data,
 * and maintains an independent Primary Capital Treasury store in IndexedDB.
 */

import { DB } from './database.js';
import { Money } from './money.js';
import { AuthModule } from './auth.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { DBProvider } from './services/dbProvider.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { TreasuryRepository } from './services/treasuryRepository.js';
import { DashboardRepository } from './services/dashboardRepository.js';

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const STORE_MAIN_CAPITAL = 'mainCapitalTreasury';
const STORE_RECEIPTS = 'receipts';
const STORE_TREASURY = 'treasury';
const STORE_OFFICES = 'offices';

const STATE = {
  quickRange: '', // 'day', 'week', 'month', or ''
  from: '',
  to: '',
  searchQuery: '',
  capitalCollapsed: false,
};

let _isSavingCapital = false; // module-scoped submit lock to prevent double-click submissions

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) throw new Error('Username required');
  return session.username;
}

function _todayISO() {
  return new Date().toISOString().split('T')[0];
}

function _uuid() {
  return crypto.randomUUID();
}

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DATE HELPERS ────────────────────────────────────────────────────────────

function _setQuickFilterRange(rangeType) {
  const to = new Date();
  const from = new Date();
  if (rangeType === 'day') {
    // Today
    STATE.from = to.toISOString().slice(0, 10);
    STATE.to = to.toISOString().slice(0, 10);
  } else if (rangeType === 'week') {
    // Last 7 days
    from.setDate(to.getDate() - 6);
    STATE.from = from.toISOString().slice(0, 10);
    STATE.to = to.toISOString().slice(0, 10);
  } else if (rangeType === 'month') {
    // Last 30 days
    from.setDate(to.getDate() - 29);
    STATE.from = from.toISOString().slice(0, 10);
    STATE.to = to.toISOString().slice(0, 10);
  } else {
    STATE.from = '';
    STATE.to = '';
  }
  STATE.quickRange = rangeType;
}

// ─── AGGREGATE CALCULATIONS (DETERMINISTIC & MEMORIZED) ──────────────────────

/**
 * Calculates Card 4: "إجمالي المحصل من الشركات"
 * Sums weight * unit_price for each company's routes from active receipts in period.
 * Optimized to run in a single pass over receipt rows using an indexed weightMap (complexity: O(R * L)).
 */
async function _calculateTotalCollectedFromCompanies(username, activeReceipts, offices) {
  const weightMap = {}; // key = officeId::loadingPlace::destinationPlace -> accumulatedWeight

  // Helper map to quickly find officeId by its normalized name
  const officeNameMap = new Map();
  if (Array.isArray(offices)) {
    for (const office of offices) {
      if (office && office.name) {
        officeNameMap.set(String(office.name).trim().toLowerCase(), String(office.id));
      }
    }
  }

  // Single pass through all active receipt rows to build the weightMap
  if (Array.isArray(activeReceipts)) {
    for (const receipt of activeReceipts) {
      if (!receipt) continue;
      const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
      for (const row of rows) {
        if (!row || row._type === 'separator') continue;
        const rowOffice = String(row.office || '').trim().toLowerCase();
        if (!rowOffice) continue;

        const officeId = officeNameMap.get(rowOffice);
        if (!officeId) continue; // Skip if office is not registered

        const loading = String(row.loading || '').trim().toLowerCase();
        const dest = String(row.taktik || row.direction || '').trim().toLowerCase();
        const w = (Number(row.weight) || 0) + (Number(row.weight2) || 0);
        if (!loading || !dest) continue;

        const key = `${officeId}::${loading}::${dest}`;
        weightMap[key] = (weightMap[key] || 0) + w;
      }
    }
  }

  // Calculate totals by iterating offices once and their routes once
  let totalCents = 0;
  if (Array.isArray(offices)) {
    for (const office of offices) {
      if (!office) continue;
      const officeId = String(office.id);
      const hamolaRows = Array.isArray(office.hamolaRows) ? office.hamolaRows : [];
      
      let officeGrandTotalCents = 0;
      for (const r of hamolaRows) {
        if (!r) continue;
        const loading = String(r.loading_place || r.loading || '').trim().toLowerCase();
        const dest = String(r.destination_place || r.direction || r.taktik || '').trim().toLowerCase();
        const key = `${officeId}::${loading}::${dest}`;
        
        const weight = weightMap[key] || 0;
        const price = Number(r.price) || 0;
        officeGrandTotalCents += Money.toCents(weight * price);
      }
      totalCents += officeGrandTotalCents;
    }
  }

  return Money.toDecimal(totalCents);
}

// ─── PRIMARY CAPITAL TREASURY STORAGE LAYER ──────────────────────────────────

async function _getCapitalTransactions(username) {
  return DashboardRepository.getCapitalTransactions(username);
}

async function _addCapitalTransaction(username, type, amount, note, date) {
  const cents = Money.toCents(amount);
  if (cents <= 0) throw new Error('❌ يجب أن يكون المبلغ أكبر من صفر');

  const payload = {
    id: _uuid(),
    username,
    type, // 'deposit' | 'withdraw'
    amount: cents,
    note: String(note || '').trim() || (type === 'deposit' ? 'إيداع رأس مال' : 'سحب رأس مال'),
    date: date || _todayISO(),
  };

  await DashboardRepository.saveTransaction(payload, { username });
  window.dispatchEvent(new CustomEvent('capital:changed'));
}

async function _deleteCapitalTransaction(username, id) {
  await DashboardRepository.deleteTransaction(id, { username });
  window.dispatchEvent(new CustomEvent('capital:changed'));
}

// ─── STYLE INJECTION FOR COMPLETE CSS ISOLATION ──────────────────────────────

function _injectIsolatedStyles() {
  if (document.getElementById('dashboard-isolated-styles')) return;

  const style = document.createElement('style');
  style.id = 'dashboard-isolated-styles';
  style.textContent = `
    /* ==========================================
       DASHBOARD NAMESPACED ISOLATED STYLES
       ========================================== */

    /* Core container */
    .dashboard-page {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      direction: rtl !important;
      text-align: right !important;
      font-family: 'Cairo', Arial, sans-serif !important;
      color: #1f2937;
      background-color: #f9fafb;
    }

    /* Isolated Cards */
    .dashboard-card {
      background: #ffffff !important;
      border-radius: 1rem !important;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08), 0 2px 4px -1px rgba(0,0,0,0.04) !important;
      padding: 1.5rem !important;
      border: 1px solid #e5e7eb !important;
      position: relative !important;
      transition: box-shadow 0.25s ease, transform 0.25s ease !important;
    }

    .dashboard-card-hover:hover {
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05) !important;
    }

    /* Header Inner Alignments */
    .dashboard-header-inner {
      display: flex;
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    @media (max-width: 1024px) {
      .dashboard-header-inner {
        flex-direction: column;
        align-items: flex-start;
      }
    }

    /* Filters Layout */
    .dashboard-filters-area {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      width: auto;
    }

    @media (max-width: 1024px) {
      .dashboard-filters-area {
        width: 100%;
      }
    }

    /* Quick Period Selector */
    .dashboard-quick-filters {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    /* Quick Filter Action Button */
    .dashboard-filter-btn {
      background-color: #e5e7eb !important;
      color: #374151 !important;
      font-weight: 700 !important;
      padding: 0.45rem 1rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      transition: background-color 0.2s, color 0.2s !important;
      font-size: 0.75rem !important;
      font-family: inherit !important;
    }

    .dashboard-filter-btn:hover {
      background-color: #2563eb !important;
      color: #ffffff !important;
    }

    .dashboard-filter-btn.active {
      background-color: #2563eb !important;
      color: #ffffff !important;
      box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2) !important;
    }

    /* Manual Period Form Container */
    .dashboard-manual-filter-bar {
      background-color: #f9fafb !important;
      border: 1px solid #e5e7eb !important;
      border-radius: 0.75rem !important;
      padding: 0.5rem 1rem !important;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .dashboard-manual-filter-bar label {
      font-size: 0.75rem !important;
      font-weight: 700 !important;
      color: #4b5563 !important;
      margin: 0 !important;
    }

    .dashboard-manual-filter-bar input[type="date"] {
      border: 1px solid #cbd5e1 !important;
      border-radius: 0.5rem !important;
      padding: 0.35rem 0.65rem !important;
      font-size: 0.8125rem !important;
      font-family: inherit !important;
      color: #1f2937 !important;
      background-color: #ffffff !important;
      outline: none !important;
      transition: border-color 0.15s, box-shadow 0.15s !important;
    }

    .dashboard-manual-filter-bar input[type="date"]:focus {
      border-color: #7c3aed !important;
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15) !important;
    }

    .dashboard-apply-btn {
      background-color: #4f46e5 !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      padding: 0.45rem 1.25rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      transition: background-color 0.15s, box-shadow 0.15s !important;
      font-size: 0.75rem !important;
      font-family: inherit !important;
    }

    .dashboard-apply-btn:hover {
      background-color: #3730a3 !important;
      box-shadow: 0 4px 6px rgba(79, 70, 229, 0.15) !important;
    }

    /* Statistics Responsive Grid */
    .dashboard-grid {
      display: grid !important;
      grid-template-columns: repeat(5, 1fr) !important;
      gap: 1rem !important;
      width: 100% !important;
    }

    @media (max-width: 1280px) {
      .dashboard-grid {
        grid-template-columns: repeat(3, 1fr) !important;
      }
    }

    @media (max-width: 768px) {
      .dashboard-grid {
        grid-template-columns: repeat(2, 1fr) !important;
      }
    }

    @media (max-width: 480px) {
      .dashboard-grid {
        grid-template-columns: 1fr !important;
      }
    }

    /* Single Statistics Card with animated hover */
    .dashboard-stat-card {
      position: relative !important;
      border-radius: 1rem !important;
      padding: 1.25rem !important;
      color: #ffffff !important;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1) !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      transform: translateY(0) !important;
      transition: transform 0.25s ease, box-shadow 0.25s ease !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: space-between !important;
      min-height: 125px !important;
    }

    .dashboard-stat-card:hover {
      transform: translateY(-4px) !important;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.15) !important;
    }

    .dashboard-stat-title {
      font-size: 0.75rem !important;
      font-weight: 700 !important;
      color: rgba(255, 255, 255, 0.88) !important;
      margin: 0 0 0.5rem 0 !important;
    }

    .dashboard-stat-value {
      font-size: 1.625rem !important;
      font-weight: 800 !important;
      color: #ffffff !important;
      margin: 0 !important;
      line-height: 1.25 !important;
      font-variant-numeric: tabular-nums !important;
      direction: ltr !important;
      unicode-bidi: embed !important;
      text-align: right !important;
    }

    .dashboard-stat-value span {
      font-size: 0.75rem !important;
      font-weight: 600 !important;
      margin-right: 3px !important;
    }

    .dashboard-stat-desc {
      font-size: 0.6875rem !important;
      color: rgba(255, 255, 255, 0.7) !important;
      margin: 0.5rem 0 0 0 !important;
    }

    /* Gradient colors for summary cards */
    .dashboard-stat-indigo  { background: linear-gradient(135deg, #4f46e5, #7c3aed) !important; }
    .dashboard-stat-rose    { background: linear-gradient(135deg, #f43f5e, #be123c) !important; }
    .dashboard-stat-teal    { background: linear-gradient(135deg, #0d9488, #115e59) !important; }
    .dashboard-stat-sky     { background: linear-gradient(135deg, #0ea5e9, #0369a1) !important; }
    .dashboard-stat-emerald { background: linear-gradient(135deg, #10b981, #047857) !important; }

    /* Capital treasury independent section container */
    .dashboard-capital-box {
      background: #ffffff !important;
      border-radius: 1rem !important;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.08) !important;
      border: 1px solid #e5e7eb !important;
      overflow: hidden !important;
    }

    .dashboard-capital-header {
      background: linear-gradient(135deg, #1f2937, #374151) !important;
      padding: 1rem 1.5rem !important;
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      cursor: pointer !important;
      user-select: none !important;
      color: #ffffff !important;
    }

    .dashboard-capital-header-title {
      display: flex !important;
      align-items: center !important;
      gap: 0.75rem !important;
      margin: 0 !important;
      color: #ffffff !important;
      font-size: 1.0625rem !important;
      font-weight: 800 !important;
    }

    .dashboard-capital-arrow {
      color: #ffffff !important;
      background: none !important;
      border: none !important;
      cursor: pointer !important;
      padding: 0.25rem !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: transform 0.25s ease !important;
    }

    .dashboard-capital-arrow svg {
      width: 1.25rem !important;
      height: 1.25rem !important;
    }

    .dashboard-capital-content {
      padding: 1.5rem !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 1.5rem !important;
    }

    .dashboard-capital-content.hidden {
      display: none !important;
    }

    .dashboard-capital-layout {
      display: grid !important;
      grid-template-columns: 1fr 2fr !important;
      gap: 1.5rem !important;
    }

    @media (max-width: 1024px) {
      .dashboard-capital-layout {
        grid-template-columns: 1fr !important;
      }
    }

    /* Balance presentation box inside capital */
    .dashboard-capital-balance-card {
      background: linear-gradient(135deg, #f9fafb, #f3f4f6) !important;
      border: 1px solid #e5e7eb !important;
      border-radius: 0.75rem !important;
      padding: 1.5rem !important;
      display: flex !important;
      flex-direction: column !important;
      justify-content: space-between !important;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.01) !important;
      height: 100% !important;
    }

    .dashboard-capital-balance-label {
      font-size: 0.8125rem !important;
      font-weight: 700 !important;
      color: #4b5563 !important;
      margin: 0 0 0.5rem 0 !important;
    }

    .dashboard-capital-balance-value {
      font-size: 2.125rem !important;
      font-weight: 800 !important;
      color: #1f2937 !important;
      margin: 0 !important;
      font-variant-numeric: tabular-nums !important;
      direction: ltr !important;
      unicode-bidi: embed !important;
      text-align: right !important;
    }

    /* Action buttons in balance card */
    .dashboard-capital-actions {
      display: flex !important;
      gap: 0.75rem !important;
      margin-top: 1.5rem !important;
    }

    .dashboard-btn {
      flex: 1 !important;
      font-weight: 700 !important;
      padding: 0.625rem 1rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      transition: background-color 0.15s, box-shadow 0.15s !important;
      font-size: 0.75rem !important;
      text-align: center !important;
      font-family: inherit !important;
    }

    .dashboard-btn-success {
      background-color: #16a34a !important;
      color: #ffffff !important;
    }

    .dashboard-btn-success:hover {
      background-color: #15803d !important;
      box-shadow: 0 4px 6px rgba(22, 163, 74, 0.15) !important;
    }

    .dashboard-btn-danger {
      background-color: #dc2626 !important;
      color: #ffffff !important;
    }

    .dashboard-btn-danger:hover {
      background-color: #b91c1c !important;
      box-shadow: 0 4px 6px rgba(220, 38, 38, 0.15) !important;
    }

    /* Transaction history controls */
    .dashboard-capital-controls {
      display: flex !important;
      flex-direction: column !important;
      gap: 1rem !important;
    }

    .dashboard-search-bar {
      display: flex !important;
      gap: 0.75rem !important;
      align-items: center !important;
    }

    .dashboard-search-input {
      flex: 1 !important;
      padding: 0.5rem 1rem !important;
      border: 1px solid #cbd5e1 !important;
      border-radius: 0.5rem !important;
      font-size: 0.75rem !important;
      outline: none !important;
      font-family: inherit !important;
      transition: border-color 0.15s, box-shadow 0.15s !important;
    }

    .dashboard-search-input:focus {
      border-color: #4f46e5 !important;
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15) !important;
    }

    .dashboard-print-btn {
      background: linear-gradient(135deg, #7c3aed, #6d28d9) !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      font-size: 0.75rem !important;
      padding: 0.5rem 1.25rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      font-family: inherit !important;
      white-space: nowrap !important;
      transition: filter 0.15s, box-shadow 0.15s !important;
    }

    .dashboard-print-btn:hover {
      filter: brightness(0.95) !important;
      box-shadow: 0 4px 6px rgba(124, 58, 237, 0.15) !important;
    }

    /* Scrolling Table Wrapper for Transactions */
    .dashboard-table-wrapper {
      border-radius: 0.75rem !important;
      border: 1px solid #e5e7eb !important;
      overflow-x: auto !important;
      overflow-y: auto !important;
      max-height: 250px !important;
    }

    /* Namespaced Table */
    .dashboard-table {
      width: 100% !important;
      border-collapse: collapse !important;
      font-size: 0.75rem !important;
      background: #ffffff !important;
    }

    .dashboard-table th {
      background-color: #1f2937 !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      padding: 0.75rem 1rem !important;
      text-align: right !important;
      white-space: nowrap !important;
    }

    .dashboard-table td {
      padding: 0.625rem 1rem !important;
      border-bottom: 1px solid #f3f4f6 !important;
      color: #374151 !important;
      vertical-align: middle !important;
      white-space: nowrap !important;
    }

    .dashboard-table tbody tr:nth-child(even) {
      background-color: #f9fafb !important;
    }

    .dashboard-table tbody tr:hover {
      background-color: #f1f5f9 !important;
    }

    /* Labels inside table */
    .dashboard-deposit-label {
      color: #15803d !important;
      font-weight: 700 !important;
      background-color: #dcfce7 !important;
      padding: 0.125rem 0.5rem !important;
      border-radius: 0.25rem !important;
      font-size: 0.6875rem !important;
      display: inline-block !important;
    }

    .dashboard-withdraw-label {
      color: #b91c1c !important;
      font-weight: 700 !important;
      background-color: #fee2e2 !important;
      padding: 0.125rem 0.5rem !important;
      border-radius: 0.25rem !important;
      font-size: 0.6875rem !important;
      display: inline-block !important;
    }

    /* Dialog Modals */
    .dashboard-modal-overlay {
      position: fixed !important;
      inset: 0 !important;
      background-color: rgba(0, 0, 0, 0.5) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      z-index: 9999 !important;
      padding: 1rem !important;
    }

    .dashboard-modal-overlay.hidden {
      display: none !important;
    }

    .dashboard-modal {
      background-color: #ffffff !important;
      border-radius: 1rem !important;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04) !important;
      width: 100% !important;
      max-width: 24rem !important;
      padding: 1.5rem !important;
      direction: rtl !important;
      text-align: right !important;
      font-family: inherit !important;
    }

    .dashboard-modal-header {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      margin-bottom: 1rem !important;
      padding-bottom: 0.5rem !important;
      border-b: 1px solid #f3f4f6 !important;
    }

    .dashboard-modal-title {
      font-size: 0.9375rem !important;
      font-weight: 800 !important;
      color: #1f2937 !important;
      margin: 0 !important;
    }

    .dashboard-modal-close {
      background: none !important;
      border: none !important;
      color: #9ca3af !important;
      cursor: pointer !important;
      padding: 0.25rem !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: color 0.15s !important;
    }

    .dashboard-modal-close:hover {
      color: #4b5563 !important;
    }

    .dashboard-modal-body {
      display: flex !important;
      flex-direction: column !important;
      gap: 1rem !important;
    }

    .dashboard-modal-field {
      display: flex !important;
      flex-direction: column !important;
      gap: 0.25rem !important;
    }

    .dashboard-modal-label {
      font-size: 0.75rem !important;
      font-weight: 700 !important;
      color: #4b5563 !important;
    }

    .dashboard-modal-input {
      width: 100% !important;
      padding: 0.5rem 0.75rem !important;
      border: 1px solid #cbd5e1 !important;
      border-radius: 0.5rem !important;
      font-size: 0.8125rem !important;
      outline: none !important;
      background-color: #ffffff !important;
      font-family: inherit !important;
      transition: border-color 0.15s, box-shadow 0.15s !important;
    }

    .dashboard-modal-input:focus {
      border-color: #2563eb !important;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15) !important;
    }

    .dashboard-modal-button {
      width: 100% !important;
      background-color: #2563eb !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      padding: 0.625rem 1rem !important;
      border-radius: 0.5rem !important;
      border: none !important;
      cursor: pointer !important;
      font-size: 0.75rem !important;
      font-family: inherit !important;
      transition: background-color 0.15s !important;
    }

    .dashboard-modal-button:hover {
      background-color: #1d4ed8 !important;
    }

    .dashboard-modal-msg {
      font-size: 0.75rem !important;
      color: #b91c1c !important;
      font-weight: 700 !important;
      background-color: #fee2e2 !important;
      border: 1px solid rgba(220, 38, 38, 0.2) !important;
      border-radius: 0.5rem !important;
      padding: 0.5rem !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── RENDERING ───────────────────────────────────────────────────────────────

function _renderShell() {
  const page = document.getElementById('dashboardPage');
  if (!page) return;

  // Render the main dashboard content container if it doesn't exist
  let mainContent = page.querySelector('.dashboard-page');
  if (!mainContent) {
    mainContent = document.createElement('div');
    mainContent.className = 'dashboard-page';
    page.appendChild(mainContent);
  }

  mainContent.innerHTML = `
      <!-- Section 1: Header + Filters -->
      <div class="dashboard-card dashboard-card-hover">
        <div class="dashboard-header-inner">
          <div>
            <h1 class="text-2xl font-bold text-gray-800" style="margin:0 0 4px 0;">Dashboard العميل</h1>
            <p class="text-muted text-xs" style="margin:0;">ملخص شامل للحركة المالية والربحية للمركبات والعملاء</p>
          </div>
          
          <!-- Filters area -->
          <div class="dashboard-filters-area">
            <!-- Row 1: Quick Filters -->
            <div class="dashboard-quick-filters">
              <button id="btnRangeDay" type="button" class="dashboard-filter-btn">يوم</button>
              <button id="btnRangeWeek" type="button" class="dashboard-filter-btn">أسبوع</button>
              <button id="btnRangeMonth" type="button" class="dashboard-filter-btn">شهر</button>
              <button id="btnRangeAll" type="button" class="dashboard-filter-btn">الكل</button>
            </div>
            
            <!-- Row 2: Manual Date Filter -->
            <div class="dashboard-manual-filter-bar">
              <label>من</label>
              <input id="dashFromDate" type="date">
              <label>إلى</label>
              <input id="dashToDate" type="date">
              <button id="btnApplyManualDate" type="button" class="dashboard-apply-btn">تطبيق</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 2: Statistics Cards Grid -->
      <div id="dashboardStatsGrid" class="dashboard-grid">
        <!-- Dynamic Cards Inserted Here -->
      </div>

      <!-- Section 3: Capital Treasury Section -->
      <div class="dashboard-capital-box">
        <!-- Collapsible Header -->
        <div id="capitalHeader" class="dashboard-capital-header">
          <div class="dashboard-capital-header-title">
            <span>💼</span>
            <span>الخزنة الرئيسية (رأس المال الخاص)</span>
          </div>
          <button id="btnCollapseCapital" class="dashboard-capital-arrow" aria-label="عرض أو إخفاء الخزنة الرئيسية">
            <svg id="svgCollapseArrow" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width:20px;height:20px; transition: transform 0.2s ease;">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/>
            </svg>
          </button>
        </div>

        <!-- Collapsible Content -->
        <div id="capitalContent" class="dashboard-capital-content">
          <div class="dashboard-capital-layout">
            <!-- Balance and Quick Actions Card -->
            <div class="dashboard-capital-balance-card">
              <div>
                <p class="dashboard-capital-balance-label">رصيد الخزنة الرئيسية الحالي</p>
                <h3 id="capitalBalanceVal" class="dashboard-capital-balance-value">0.00 جنيه</h3>
              </div>
              <div class="dashboard-capital-actions">
                <button id="btnCapitalDeposit" type="button" class="dashboard-btn dashboard-btn-success">➕ إيداع رأس مال</button>
                <button id="btnCapitalWithdraw" type="button" class="dashboard-btn dashboard-btn-danger">➖ سحب رأس مال</button>
              </div>
            </div>

            <!-- Transaction Table and Search Area -->
            <div class="dashboard-capital-controls">
              <div class="dashboard-search-bar">
                <input id="capitalSearchInput" type="text" placeholder="🔍 ابحث في حركات الخزنة الرئيسية..." class="dashboard-search-input">
                <button id="btnPrintCapital" type="button" class="dashboard-print-btn">🖨️ طباعة كشف الخزنة</button>
              </div>

              <div class="dashboard-table-wrapper">
                <table class="dashboard-table">
                  <thead>
                    <tr>
                      <th>التاريخ</th>
                      <th style="text-align:center;">النوع</th>
                      <th>المبلغ</th>
                      <th>البيان / الملاحظات</th>
                      <th style="text-align:center;">المسؤول</th>
                      <th style="text-align:center;" class="no-print">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody id="capitalTableBody">
                    <!-- Dynamic rows inserted here -->
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Section 4: Spacing Area / Footer -->
      <div style="padding: 1rem 0; text-align: center; font-size: 0.75rem; color: var(--color-gray-400); font-weight: 700; border-top: 1px solid var(--color-gray-200);">
        نظام Karta المالي — لوحة التحكم الذكية &copy; 2026
      </div>
  `;

  // Render the modal overlay container ONLY once
  let modal = page.querySelector('#dashCapitalModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'dashCapitalModal';
    modal.className = 'dashboard-modal-overlay hidden';
    modal.innerHTML = `
      <div class="dashboard-modal">
        <div class="dashboard-modal-header">
          <h3 id="dashModalTitle" class="dashboard-modal-title">إيداع رأس مال</h3>
          <button id="btnDashModalClose" type="button" class="dashboard-modal-close" aria-label="إغلاق النافذة">
            <svg style="width:20px;height:20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="dashboard-modal-body">
          <div class="dashboard-modal-field">
            <label class="dashboard-modal-label" for="dashModalAmount">المبلغ (جنيه)</label>
            <input id="dashModalAmount" type="number" min="0.01" step="0.01" placeholder="0.00" class="dashboard-modal-input">
          </div>
          <div class="dashboard-modal-field">
            <label class="dashboard-modal-label" for="dashModalDate">التاريخ</label>
            <input id="dashModalDate" type="date" class="dashboard-modal-input">
          </div>
          <div class="dashboard-modal-field">
            <label class="dashboard-modal-label" for="dashModalNote">ملاحظة / بيان الحركة</label>
            <input id="dashModalNote" type="text" placeholder="اكتب بياناً موجزاً للحركة" class="dashboard-modal-input">
          </div>
          <div id="dashModalMsg" class="dashboard-modal-msg hidden"></div>
          <button id="btnDashModalSave" type="button" class="dashboard-modal-button">حفظ الحركة</button>
        </div>
      </div>
    `;
    page.appendChild(modal);
  }
}

async function _refreshDashboard() {
  const username = _currentUsername();

  // 1. Read raw tables via repositories
  const allReceipts = await ReceiptRepository.getAll(username);
  const allTreasury = await TreasuryRepository.getAll(username);
  const offices = await DBProvider.getAll(STORE_OFFICES, { username });

  // 2. Filter datasets based on selected dates with defense guards
  const activeReceipts = (allReceipts || []).filter(r => {
    if (!r || r.deleted_at !== null) return false;
    const d = String(r.receipt_date || '').split('T')[0];
    if (STATE.from && d < STATE.from) return false;
    if (STATE.to && d > STATE.to) return false;
    return true;
  });

  const activeTreasury = (allTreasury || []).filter(t => {
    if (!t || t.is_reversed === true || t.deleted_at !== null) return false;
    const d = String(t.date || '').split('T')[0];
    if (STATE.from && d < STATE.from) return false;
    if (STATE.to && d > STATE.to) return false;
    return true;
  });

  // ─── CALCULATE STATISTICS ──────────────────────────────────────────────────

  // Card 1: "إجمالي صرف الكارتات" — Sum of net_due from filtered active receipts
  let totalReceiptCents = 0;
  for (const r of activeReceipts) {
    if (r) {
      totalReceiptCents += Number(r.net_due) || 0; // net_due is stored as cents
    }
  }
  const totalReceiptsVal = Money.toDecimal(totalReceiptCents);

  // Card 2: "المصروفات والمرتبات" — Sum of amount from filtered active treasury (expenses/salaries)
  let totalExpenseCents = 0;
  for (const t of activeTreasury) {
    if (t && (t.effect === 'expense' || t.effect === 'salary')) {
      totalExpenseCents += Number(t.amount) || 0; // amount is stored as cents
    }
  }
  const totalExpenseVal = Money.toDecimal(totalExpenseCents);

  // Card 3: "إجمالي المكتب" — Sum of officeAmount from active receipts within selected period
  let totalOfficeCents = 0;
  for (const r of activeReceipts) {
    if (r) {
      const rows = Array.isArray(r.rows) ? r.rows : [];
      for (const row of rows) {
        if (!row || row._type === 'separator') continue;
        totalOfficeCents += Money.toCents(row.officeAmount || row.office_amount || 0);
      }
    }
  }
  const totalOfficeVal = Money.toDecimal(totalOfficeCents);

  // Card 4: "إجمالي المحصل من الشركات" — Calculated with prices map & routes weight
  const totalCollectedFromCompanies = await _calculateTotalCollectedFromCompanies(username, activeReceipts, offices);

  // Card 5: "صافي الربح" = Companies Collected + Office Amount - Receipts Spent - Salaries/Expenses
  const netProfitCents = Money.toCents(totalCollectedFromCompanies) 
                         + Money.toCents(totalOfficeVal) 
                         - Money.toCents(totalReceiptsVal) 
                         - Money.toCents(totalExpenseVal);
  const netProfitVal = Money.toDecimal(netProfitCents);

  // ─── RENDER STATISTICS CARDS ────────────────────────────────────────────────

  _renderSummaryCards(totalReceiptsVal, totalExpenseVal, totalOfficeVal, totalCollectedFromCompanies, netProfitVal);

  // ─── RENDER CAPITAL TREASURY ────────────────────────────────────────────────

  await _renderCapitalTreasury(username);
}

function _renderSummaryCards(card1, card2, card3, card4, card5) {
  const container = document.getElementById('dashboardStatsGrid');
  if (!container) return;

  const fmt = (v) => Money.fmt(v);

  const cardHtml = (title, value, description, gradientClass) => `
    <div class="dashboard-stat-card ${gradientClass}">
      <div>
        <p class="dashboard-stat-title">${_esc(title)}</p>
        <p class="dashboard-stat-value">${fmt(value)} <span>ج.م</span></p>
      </div>
      <p class="dashboard-stat-desc">${_esc(description)}</p>
    </div>`;

  container.innerHTML = `
    ${cardHtml('إجمالي صرف الكارتات', card1, 'صافي الصرف في الفترة المحددة', 'dashboard-stat-indigo')}
    ${cardHtml('المصروفات والمرتبات', card2, 'المصاريف التشغيلية والمرتبات المباشرة', 'dashboard-stat-rose')}
    ${cardHtml('إجمالي المكتب', card3, 'نسبة عمولة المكتب المحصلة من الكارتات', 'dashboard-stat-teal')}
    ${cardHtml('إجمالي المحصل من العملاء', card4, 'مجموع مستحقات الحمولة من العملاء ماليًا', 'dashboard-stat-sky')}
    ${cardHtml('صافي الربح', card5, 'المعادلة: المحصل + المكتب - الكارتات - المصاريف', card5 >= 0 ? 'dashboard-stat-emerald' : 'dashboard-stat-rose')}
  `;
}

async function _renderCapitalTreasury(username) {
  const tableBody = document.getElementById('capitalTableBody');
  const balanceValEl = document.getElementById('capitalBalanceVal');
  if (!tableBody || !balanceValEl) return;

  const transactions = await _getCapitalTransactions(username);

  // Calculate Running Balance
  let totalBalanceCents = 0;
  for (const t of (transactions || [])) {
    if (t) {
      if (t.type === 'deposit') {
        totalBalanceCents += Number(t.amount) || 0;
      } else {
        totalBalanceCents -= Number(t.amount) || 0;
      }
    }
  }
  const currentBalanceDecimal = Money.toDecimal(totalBalanceCents);
  balanceValEl.textContent = `${Money.fmt(currentBalanceDecimal)} جنيه`;

  // Apply Search Query Filter safely
  const query = (STATE.searchQuery || '').trim().toLowerCase();
  const filtered = query
    ? (transactions || []).filter(t => {
        if (!t) return false;
        const typeLabel = t.type === 'deposit' ? 'إيداع' : 'سحب';
        const hay = [
          t.date,
          typeLabel,
          String(Money.toDecimal(t.amount)),
          t.note,
          t.created_by,
        ].join(' ').toLowerCase();
        return hay.includes(query);
      })
    : (transactions || []);

  // Sort by created_at descending (latest first)
  filtered.sort((a, b) => {
    const timeA = a && a.created_at ? a.created_at : 0;
    const timeB = b && b.created_at ? b.created_at : 0;
    return timeB - timeA;
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-gray-400 p-6 font-bold" style="background:#f9fafb;">لا توجد حركات مطابقة في سجل الخزنة الرئيسية</td></tr>`;
    return;
  }

  tableBody.innerHTML = filtered.map(t => {
    if (!t) return '';
    const isDeposit = t.type === 'deposit';
    const amountFormatted = Money.fmt(Money.toDecimal(t.amount));
    const typeLabel = isDeposit ? 'إيداع' : 'سحب';
    const labelClass = isDeposit ? 'dashboard-deposit-label' : 'dashboard-withdraw-label';

    return `
      <tr>
        <td>${_esc(t.date)}</td>
        <td style="text-align:center;"><span class="${labelClass}">${typeLabel}</span></td>
        <td class="font-bold ${isDeposit ? 'text-success' : 'text-danger'}" style="direction:ltr;unicode-bidi:embed;text-align:right;">${isDeposit ? '+' : '-'}${amountFormatted}</td>
        <td style="color:#4b5563; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_esc(t.note)}">${_esc(t.note)}</td>
        <td style="text-align:center; color:#6b7280;">${_esc(t.created_by)}</td>
        <td style="text-align:center;" class="no-print">
          <button type="button" data-action="delete-capital" data-id="${t.id}" style="background:none;border:none;cursor:pointer;font-size:0.875rem;" title="حذف الحركة">
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── PRINT HANDLER ───────────────────────────────────────────────────────────

function _printCapitalTreasury() {
  const tbody = document.getElementById('capitalTableBody');
  if (!tbody) return;

  const rows = [...tbody.querySelectorAll('tr')];
  if (rows.length === 0 || rows[0].textContent.includes('لا توجد حركات')) {
    alert('لا توجد حركات للطباعة في سجل الخزنة الرئيسية');
    return;
  }

  let tableRows = '';
  let totalIn = 0, totalOut = 0;

  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 5) return;
    const date = (cells[0]?.textContent || '').trim();
    const type = (cells[1]?.textContent || '').trim();
    const amountText = (cells[2]?.textContent || '').trim();
    const notes = (cells[3]?.textContent || '').trim();
    const creator = (cells[4]?.textContent || '').trim();

    const amount = parseFloat(amountText.replace(/[^0-9.\-]/g, '')) || 0;
    if (amountText.startsWith('+')) totalIn += Math.abs(amount);
    else totalOut += Math.abs(amount);

    tableRows += `
      <tr>
        <td style="padding:6px;border:1px solid #000;text-align:center;">${date}</td>
        <td style="padding:6px;border:1px solid #000;text-align:center;">${type}</td>
        <td style="padding:6px;border:1px solid #000;text-align:center;font-weight:700;">${amountText}</td>
        <td style="padding:6px;border:1px solid #000;text-align:right;">${notes}</td>
        <td style="padding:6px;border:1px solid #000;text-align:center;">${creator}</td>
      </tr>`;
  });

  const now = new Date();
  const dateStr = now.toLocaleDateString('ar-EG', { dateStyle: 'full' });
  const timeStr = now.toLocaleTimeString('ar-EG', { timeStyle: 'short' });

  const body = `
    <div style="text-align:center;margin-bottom:16px;border-bottom:2px solid #1e3a8a;padding-bottom:10px;">
      <h2 style="margin:0;color:#1e3a8a;font-size:16pt;">كشف حساب الخزنة الرئيسية (رأس المال الخاص)</h2>
      <p style="margin:4px 0 0;color:#6b7280;font-size:9pt;">تاريخ الطباعة: ${dateStr} — ${timeStr}</p>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:14px;direction:rtl;">
      <div style="flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px;text-align:center;">
        <div style="font-size:8pt;color:#6b7280;">إجمالي الإيداعات</div>
        <div style="font-size:13pt;font-weight:800;color:#059669;">+${Money.fmt(totalIn)} ج.م</div>
      </div>
      <div style="flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px;text-align:center;">
        <div style="font-size:8pt;color:#6b7280;">إجمالي السحوبات</div>
        <div style="font-size:13pt;font-weight:800;color:#dc2626;">-${Money.fmt(totalOut)} ج.م</div>
      </div>
      <div style="flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:8px;text-align:center;background-color:#f1f5f9;">
        <div style="font-size:8pt;color:#6b7280;">صافي الرصيد الحالي</div>
        <div style="font-size:13pt;font-weight:800;color:#1e3a8a;">${Money.fmt(totalIn - totalOut)} ج.م</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;direction:rtl;text-align:right;">
      <thead>
        <tr>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #000;font-size:9pt;text-align:center;">التاريخ</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #000;font-size:9pt;text-align:center;">النوع</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #000;font-size:9pt;text-align:center;">المبلغ</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #000;font-size:9pt;text-align:right;">الملاحظات / البيان</th>
          <th style="background:#1e3a8a;color:#fff;padding:8px;border:1px solid #000;font-size:9pt;text-align:center;">المسؤول</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;

  printHTML(buildPrintDocument({
    title: 'طباعة كشف الخزنة الرئيسية',
    body,
    orientation: 'portrait',
  }), { id: 'capital-print-iframe' });
}

// ─── CAPITAL TREASURY MODAL OPERATIONS ────────────────────────────────────────

let _modalTransactionType = 'deposit'; // 'deposit' or 'withdraw'

function _openCapitalModal(type) {
  _modalTransactionType = type;
  const modal = document.getElementById('dashCapitalModal');
  const title = document.getElementById('dashModalTitle');
  const amount = document.getElementById('dashModalAmount');
  const date = document.getElementById('dashModalDate');
  const note = document.getElementById('dashModalNote');
  const msg = document.getElementById('dashModalMsg');

  if (title) title.textContent = type === 'deposit' ? '➕ إيداع رأس مال في الخزنة الرئيسية' : '➖ سحب رأس مال من الخزنة الرئيسية';
  if (amount) amount.value = '';
  if (date) date.value = _todayISO();
  if (note) note.value = '';
  if (msg) { msg.textContent = ''; msg.classList.add('hidden'); }

  modal?.classList.remove('hidden');
}

function _closeCapitalModal() {
  document.getElementById('dashCapitalModal')?.classList.add('hidden');
}

async function _saveCapitalTransactionFromModal() {
  if (_isSavingCapital) return;

  const btn = document.getElementById('btnDashModalSave');
  const amountEl = document.getElementById('dashModalAmount');
  const dateEl = document.getElementById('dashModalDate');
  const noteEl = document.getElementById('dashModalNote');
  const msgEl = document.getElementById('dashModalMsg');

  const amount = parseFloat(amountEl?.value) || 0;
  const date = dateEl?.value || '';
  const note = noteEl?.value || '';

  if (msgEl) { msgEl.textContent = ''; msgEl.classList.add('hidden'); }

  if (amount <= 0) {
    if (msgEl) { msgEl.textContent = '❌ الرجاء إدخال مبلغ صحيح أكبر من صفر'; msgEl.classList.remove('hidden'); }
    return;
  }
  if (!date) {
    if (msgEl) { msgEl.textContent = '❌ الرجاء اختيار التاريخ'; msgEl.classList.remove('hidden'); }
    return;
  }

  _isSavingCapital = true;
  let originalBtnText = '';
  if (btn) {
    btn.disabled = true;
    originalBtnText = btn.textContent;
    btn.textContent = 'جاري الحفظ...';
  }

  try {
    const username = _currentUsername();
    await _addCapitalTransaction(username, _modalTransactionType, amount, note, date);
    _closeCapitalModal();
    await _refreshDashboard();
  } catch (err) {
    if (msgEl) { msgEl.textContent = err.message || '❌ حدث خطأ غير متوقع'; msgEl.classList.remove('hidden'); }
  } finally {
    _isSavingCapital = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalBtnText;
    }
  }
}

// ─── SYNC NAVIGATION ACTIVE TABS ─────────────────────────────────────────────

function _syncQuickRangeButtons() {
  const btnDay = document.getElementById('btnRangeDay');
  const btnWeek = document.getElementById('btnRangeWeek');
  const btnMonth = document.getElementById('btnRangeMonth');
  const btnAll = document.getElementById('btnRangeAll');

  const removeAllActive = () => {
    [btnDay, btnWeek, btnMonth, btnAll].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
  };

  removeAllActive();

  if (STATE.quickRange === 'day' && btnDay) btnDay.classList.add('active');
  else if (STATE.quickRange === 'week' && btnWeek) btnWeek.classList.add('active');
  else if (STATE.quickRange === 'month' && btnMonth) btnMonth.classList.add('active');
  else if (STATE.quickRange === '' && btnAll) btnAll.classList.add('active');

  const dashFrom = document.getElementById('dashFromDate');
  const dashTo = document.getElementById('dashToDate');
  if (dashFrom) dashFrom.value = STATE.from || '';
  if (dashTo) dashTo.value = STATE.to || '';
}

// ─── DOM EVENT BINDING ───────────────────────────────────────────────────────

let _bound = false;

function _attachListeners() {
  if (_bound) return;
  _bound = true;

  document.addEventListener('click', async (e) => {
    // Scope all delegated click listeners strictly inside #dashboardPage or modal overlay
    const insideDashboard = e.target.closest('#dashboardPage') || e.target.closest('#dashCapitalModal');
    if (!insideDashboard) return;

    const id = e.target.id;
    const action = e.target.dataset.action;

    // Quick range filters
    if (id === 'btnRangeDay') {
      _setQuickFilterRange('day');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeWeek') {
      _setQuickFilterRange('week');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeMonth') {
      _setQuickFilterRange('month');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }
    if (id === 'btnRangeAll') {
      _setQuickFilterRange('');
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }

    // Apply manual range filter
    if (id === 'btnApplyManualDate') {
      STATE.from = document.getElementById('dashFromDate')?.value || '';
      STATE.to = document.getElementById('dashToDate')?.value || '';
      STATE.quickRange = 'manual';
      _syncQuickRangeButtons();
      await _refreshDashboard();
      return;
    }

    // Collapsible capital header
    const capitalHeader = e.target.closest('#capitalHeader');
    if (capitalHeader) {
      STATE.capitalCollapsed = !STATE.capitalCollapsed;
      const content = document.getElementById('capitalContent');
      const arrow = document.getElementById('svgCollapseArrow');
      if (content) content.classList.toggle('hidden', STATE.capitalCollapsed);
      if (arrow) {
        if (STATE.capitalCollapsed) {
          arrow.style.transform = 'rotate(180deg)';
        } else {
          arrow.style.transform = 'rotate(0deg)';
        }
      }
      return;
    }

    // Capital deposits / withdrawals
    if (id === 'btnCapitalDeposit') {
      _openCapitalModal('deposit');
      return;
    }
    if (id === 'btnCapitalWithdraw') {
      _openCapitalModal('withdraw');
      return;
    }
    if (e.target.closest('#btnDashModalClose')) {
      _closeCapitalModal();
      return;
    }
    if (e.target.closest('#btnDashModalSave')) {
      await _saveCapitalTransactionFromModal();
      return;
    }

    // Delete capital entry
    if (action === 'delete-capital') {
      if (!confirm('هل تريد حذف هذه الحركة من سجل الخزنة الرئيسية؟')) return;
      const entryId = e.target.dataset.id;
      if (entryId) {
        await _deleteCapitalTransaction(_currentUsername(), entryId);
        await _refreshDashboard();
      }
      return;
    }

    // Print capital treasury
    if (id === 'btnPrintCapital') {
      _printCapitalTreasury();
      return;
    }
  });

  // Search filter typing - scoped strictly inside #dashboardPage
  document.addEventListener('input', async (e) => {
    const dashboardRoot = e.target.closest('#dashboardPage') || e.target.closest('#dashCapitalModal');
    if (!dashboardRoot) return;

    if (e.target.id === 'capitalSearchInput') {
      STATE.searchQuery = e.target.value || '';
      await _renderCapitalTreasury(_currentUsername());
    }
  });

  // External sync events - these are window events but guarded by visibility checks inside
  window.addEventListener('capital:changed', async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });

  window.addEventListener('receipts:changed', async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });

  window.addEventListener('treasury:changed', async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });

  window.addEventListener('offices:changed', async () => {
    const page = document.getElementById('dashboardPage');
    if (page && !page.classList.contains('hidden')) {
      await _refreshDashboard();
    }
  });
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

export async function initDashboardPage() {
  const session = AuthModule.getSession();
  if (session?.role !== 'admin') {
    console.warn('[Dashboard] Unauthorized access attempt blocked.');
    return;
  }

  _injectIsolatedStyles();
  _renderShell();
  _attachListeners();
  _syncQuickRangeButtons();
  await _refreshDashboard();
}
