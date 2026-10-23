/**
 * app.js — bootstrap, routing, initialization
 */

import { DB }          from './database.js';
import { AuthModule }  from './auth.js';
import { initReceiptPage } from './receipts.js';
import { initBolsaPage } from './bolsas.js';
import { initAllReceiptsPage } from './allReceipts.js';
import { attachOwnersPageListeners, loadOwners } from './entities.js';
import { attachOfficesPageListeners, initOfficesPage, loadOffices } from './offices.js';
import { initTreasuryPage } from './treasury.js';
import { initHomePage } from './home.js';
import { initSidebarLayout } from './sidebarLayout.js';
import { initDashboardPage } from './dashboard.js';
import './entities.js';

let _bolsaInited = false;
const LAST_PAGE_KEY = 'financial_last_page';
const LAST_PAGE_CTX_KEY = 'financial_last_page_ctx';
const PAGE_MAP = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receiptPage',
  allReceipts: 'allReceiptsPage',
  bolsa: 'bolsaPage',
  bolsaPage: 'bolsaPage',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  agentDetailsPage: 'agentDetailsPage',
  officesPage: 'officesPage',
  treasuryPage: 'treasuryPage',
  officeDetailsPage: 'officeDetailsPage',
};
const PAGE_KEY_NORMALIZE = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receipt',
  receiptPage: 'receipt',
  allReceipts: 'allReceipts',
  allReceiptsPage: 'allReceipts',
  bolsa: 'bolsaPage',
  bolsaPage: 'bolsaPage',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  agentDetailsPage: 'agentDetailsPage',
  officesPage: 'officesPage',
  treasuryPage: 'treasuryPage',
  officeDetailsPage: 'officeDetailsPage',
};

function _readLastPage() {
  return sessionStorage.getItem(LAST_PAGE_KEY);
}

function _writeLastPage(pageId) {
  if (!pageId) return;
  sessionStorage.setItem(LAST_PAGE_KEY, pageId);
}

function _readLastPageContext() {
  const raw = sessionStorage.getItem(LAST_PAGE_CTX_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _resolvePageElement(pageName) {
  // allow passing direct section id (e.g. "bolsaPage")
  const direct = document.getElementById(pageName);
  if (direct) return direct;
  return document.getElementById(PAGE_MAP[pageName]);
}

function _resolvePageKey(pageName, targetId) {
  if (PAGE_KEY_NORMALIZE[pageName]) return PAGE_KEY_NORMALIZE[pageName];
  if (PAGE_KEY_NORMALIZE[targetId]) return PAGE_KEY_NORMALIZE[targetId];
  if (PAGE_MAP[pageName]) return pageName;
  if (PAGE_MAP[targetId]) return targetId;
  return pageName || targetId || '';
}

async function showPage(pageName) {
  const session = AuthModule.getSession();
  const role = session?.role || 'user';

  // Secure Navigation Layer
  if (role !== 'admin') {
    const targetEl = _resolvePageElement(pageName);
    const targetId = targetEl?.id || '';
    const pageKey = _resolvePageKey(pageName, targetId);
    if (pageKey === 'dashboardPage' || targetId === 'dashboardPage') {
      pageName = 'homePage';
    }
  }

  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.add('hidden'));

  const target = _resolvePageElement(pageName);
  if (target) {
    target.classList.remove('hidden');
  }

  const targetId = target?.id || '';
  const pageKey = _resolvePageKey(pageName, targetId);
  _writeLastPage(pageKey);

  // ── Sidebar active state ──
  document.querySelectorAll('#sidebar .sidebar-link').forEach(link => {
    const lp = link.dataset.page;
    link.classList.toggle('active', lp === pageKey || lp === targetId);
  });

  if (pageName === 'ownersPage' || targetId === 'ownersPage') {
    await loadOwners();
  }
  if (pageName === 'officesPage' || targetId === 'officesPage') {
    await loadOffices();
  }
  if (pageName === 'bolsaPage' || pageName === 'bolsa' || targetId === 'bolsaPage') {
    if (!_bolsaInited) {
      initBolsaPage();
      _bolsaInited = true;
    }
  }
  if (pageName === 'allReceipts' || targetId === 'allReceiptsPage') {
    await initAllReceiptsPage();
  }
  if (pageName === 'dashboardPage' || targetId === 'dashboardPage') {
    if (role === 'admin') {
      await initDashboardPage();
    } else {
      await showPage('homePage');
    }
  }
  if (pageName === 'treasuryPage' || targetId === 'treasuryPage') {
    initHomePage();
    initTreasuryPage();
  }
  if (pageName === 'homePage' || targetId === 'homePage') {
    initHomePage();
  }
}

window.showPage = showPage;

function _bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    AuthModule.logout();
    window.location.href = 'login.html';
  });
}

async function boot() {
  try {
    const session = AuthModule.getSession();
    if (!session) {
      window.location.href = 'login.html';
      return;
    }

    const username = session.username;
    if (!username) {
      throw new Error('Session username is required');
    }

    window.__APP_CONTEXT__ = Object.freeze({
      username,
      role: session.role,
    });

    await DB.init();

    // Secure Sidebar Visibility for non-admins
    if (session.role !== 'admin') {
      const dbLink = document.querySelector('[data-page="dashboardPage"]');
      if (dbLink) {
        dbLink.remove();
      }
    }

    initSidebarLayout();
    _bindLogout();
    initReceiptPage();
    await initAllReceiptsPage();
    initOfficesPage();
    attachOwnersPageListeners();
    attachOfficesPageListeners();
    initTreasuryPage();
    const lastPage = _readLastPage();
    const ctx = _readLastPageContext();
    let restored = false;

    if (lastPage === 'officeDetailsPage' && ctx?.officeId && typeof window.showOfficeDetails === 'function') {
      await window.showOfficeDetails(ctx.officeId);
      restored = true;
    } else if (lastPage === 'ownerDetailsPage' && ctx?.ownerId && typeof window.showOwnerDetails === 'function') {
      await window.showOwnerDetails(ctx.ownerId, ctx.ownerType || 'owner');
      restored = true;
    } else if (lastPage === 'agentDetailsPage' && ctx?.mandoubId && typeof window.showMandoubDetails === 'function') {
      await window.showMandoubDetails(ctx.mandoubId);
      restored = true;
    }

    if (!restored) {
      let fallbackPage = lastPage;
      if (lastPage === 'officeDetailsPage') fallbackPage = 'officesPage';
      if (lastPage === 'ownerDetailsPage' || lastPage === 'agentDetailsPage') fallbackPage = 'ownersPage';
      if (!fallbackPage || !_resolvePageElement(fallbackPage)) fallbackPage = 'homePage';
      await showPage(fallbackPage);
    }

    // sidebar [data-page] navigation (unified — no more onclick)
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn) return;
      const pageId = btn.dataset.page;
      if (pageId) showPage(pageId);
    });

  } catch (err) {
    console.error('[app] Boot failed:', err);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML = `
        <div class="login-page">
          <div class="login-card shadow-lg">
            <div class="alert alert-error flex-col gap-4 text-center">
              <span class="text-2xl mb-2" aria-hidden="true">⚠️</span>
              <p class="font-bold text-lg mb-2">فشل تحميل التطبيق</p>
              <p class="text-muted text-sm mb-0">${err.message || 'خطأ غير معروف'}</p>
            </div>
          </div>
        </div>`;
    }
  }
}

boot();


// ─────────────────────────────────────────────────────────────────────────────
// BACKUP SYSTEM — Full IndexedDB export/import + auto-reminder
// Added for production safety. Does NOT modify DB schema or financial logic.
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DATE_KEY = 'karta_last_backup_date';
const BACKUP_REMINDER_DISMISSED_KEY = 'karta_backup_reminder_dismissed';
const BACKUP_REMINDER_DAYS = 7;

/**
 * Export full backup — reads ALL stores (including soft-deleted records)
 * and saves as a timestamped JSON file.
 */
async function _exportFullBackup() {
  try {
    const allStores = Object.keys(DB.STORES);
    const backup = {
      _meta: {
        version: 1,
        exportedAt: new Date().toISOString(),
        exportedBy: window.__APP_CONTEXT__?.username || 'unknown',
        storeNames: allStores,
      },
      stores: {},
    };

    for (const storeName of allStores) {
      // Read ALL records including soft-deleted (dump uses includeDeleted-like full scan)
      const { store } = _openReadTx(storeName);
      backup.stores[storeName] = await _idbGetAll(store);
    }

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `karta-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.json`;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);

    // Track backup date
    localStorage.setItem(BACKUP_DATE_KEY, now.toISOString());
    localStorage.removeItem(BACKUP_REMINDER_DISMISSED_KEY);
    _hideBackupReminder();

    alert(`✅ تم تصدير النسخة الاحتياطية بنجاح\n${filename}`);
  } catch (err) {
    console.error('[Backup] Export failed:', err);
    alert(`❌ فشل تصدير النسخة الاحتياطية\n${err.message || 'خطأ غير معروف'}`);
  }
}

// Internal helpers to read directly from IndexedDB without DB.dump()
// (DB.dump() is localhost-only; these work in production)
function _openReadTx(storeName) {
  const db = _getDbInstance();
  const tx = db.transaction(storeName, 'readonly');
  return { tx, store: tx.objectStore(storeName) };
}

function _getDbInstance() {
  // Access the internal DB instance via DB.init() promise resolution
  // Since boot() already called DB.init(), the DB is ready
  return DB._db || (function() { throw new Error('DB not initialized'); })();
}

function _idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Import full backup — validates JSON, confirms with user, then replaces
 * all store contents atomically.
 */
async function _importFullBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;

    try {
      const text = await file.text();
      let backup;
      try {
        backup = JSON.parse(text);
      } catch {
        alert('❌ الملف غير صالح — ليس بصيغة JSON صحيحة');
        return;
      }

      // Validate structure
      if (!backup?._meta?.version || !backup?.stores || typeof backup.stores !== 'object') {
        alert('❌ الملف ليس نسخة احتياطية صالحة من نظام Karta');
        return;
      }

      const storeNames = Object.keys(backup.stores);
      const knownStores = Object.keys(DB.STORES);
      const unknownStores = storeNames.filter(s => !knownStores.includes(s));
      if (unknownStores.length > 0) {
        alert(`❌ الملف يحتوي على بيانات غير معروفة: ${unknownStores.join(', ')}`);
        return;
      }

      // Count records
      let totalRecords = 0;
      for (const store of storeNames) {
        if (!Array.isArray(backup.stores[store])) {
          alert(`❌ بيانات المتجر "${store}" غير صالحة`);
          return;
        }
        totalRecords += backup.stores[store].length;
      }

      const exportDate = backup._meta.exportedAt
        ? new Date(backup._meta.exportedAt).toLocaleString('ar-EG')
        : 'غير معروف';

      // Double confirmation
      const msg = `⚠️ هل أنت متأكد من استيراد هذه النسخة الاحتياطية؟\n\n` +
        `📅 تاريخ النسخة: ${exportDate}\n` +
        `📦 عدد الجداول: ${storeNames.length}\n` +
        `📊 عدد السجلات: ${totalRecords}\n\n` +
        `⚠️ سيتم حذف جميع البيانات الحالية واستبدالها بالنسخة الاحتياطية.\n` +
        `⚠️ يُنصح بإنشاء نسخة احتياطية من البيانات الحالية أولاً.\n\n` +
        `هل تريد المتابعة؟`;

      if (!confirm(msg)) return;
      if (!confirm('⚠️ تأكيد نهائي: سيتم حذف جميع البيانات الحالية. هل أنت متأكد؟')) return;

      // Perform import — clear all stores then write backup data
      const db = _getDbInstance();
      const storesToImport = storeNames.filter(s => db.objectStoreNames.contains(s));

      await new Promise((resolve, reject) => {
        const tx = db.transaction(storesToImport, 'readwrite');
        let done = false;

        tx.onerror = () => { if (!done) { done = true; reject(tx.error); } };
        tx.onabort = () => { if (!done) { done = true; reject(new Error('Transaction aborted')); } };
        tx.oncomplete = () => { if (!done) { done = true; resolve(); } };

        try {
          for (const storeName of storesToImport) {
            const store = tx.objectStore(storeName);
            // Clear all existing records
            store.clear();
            // Write all backup records
            const records = backup.stores[storeName];
            for (const record of records) {
              store.put(record);
            }
          }
        } catch (err) {
          try { tx.abort(); } catch (_) {}
          if (!done) { done = true; reject(err); }
        }
      });

      alert('✅ تم استيراد النسخة الاحتياطية بنجاح!\nسيتم إعادة تحميل الصفحة...');
      window.location.reload();

    } catch (err) {
      console.error('[Backup] Import failed:', err);
      alert(`❌ فشل استيراد النسخة الاحتياطية\n${err.message || 'خطأ غير معروف'}`);
    }
  });

  input.click();
}

/**
 * Backup reminder — checks localStorage for last backup date,
 * shows a dismissible banner if >7 days old.
 */
function _checkBackupReminder() {
  const banner = document.getElementById('backupReminderBanner');
  if (!banner) return;

  const lastBackup = localStorage.getItem(BACKUP_DATE_KEY);
  const dismissed = localStorage.getItem(BACKUP_REMINDER_DISMISSED_KEY);

  // If dismissed today, don't show
  if (dismissed) {
    const dismissedDate = new Date(dismissed);
    const now = new Date();
    if (now.toDateString() === dismissedDate.toDateString()) return;
  }

  let shouldShow = false;
  const dateDisplay = document.getElementById('lastBackupDateDisplay');

  if (!lastBackup) {
    shouldShow = true;
    if (dateDisplay) dateDisplay.textContent = 'لم يتم إنشاء نسخة بعد';
  } else {
    const lastDate = new Date(lastBackup);
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= BACKUP_REMINDER_DAYS) {
      shouldShow = true;
    }
    if (dateDisplay) {
      dateDisplay.textContent = lastDate.toLocaleDateString('ar-EG', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    }
  }

  if (shouldShow) {
    banner.classList.remove('hidden');
    banner.style.display = 'flex';
  }
}

function _hideBackupReminder() {
  const banner = document.getElementById('backupReminderBanner');
  if (banner) {
    banner.classList.add('hidden');
    banner.style.display = 'none';
  }
}

// ── Bind backup buttons after DOM is ready ──
function _initBackupSystem() {
  const exportBtn = document.getElementById('exportBackupBtn');
  const importBtn = document.getElementById('importBackupBtn');
  const dismissBtn = document.getElementById('dismissBackupReminder');

  if (exportBtn && !exportBtn.dataset.bound) {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', _exportFullBackup);
  }
  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = '1';
    importBtn.addEventListener('click', _importFullBackup);
  }
  if (dismissBtn && !dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = '1';
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem(BACKUP_REMINDER_DISMISSED_KEY, new Date().toISOString());
      _hideBackupReminder();
    });
  }

  // Check reminder after short delay to not block boot
  setTimeout(_checkBackupReminder, 2000);
}

// Hook into boot completion
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(_initBackupSystem, 500));
} else {
  setTimeout(_initBackupSystem, 500);
}
