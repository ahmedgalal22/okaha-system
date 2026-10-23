/**
 * home.js — الصفحة الرئيسية
 */

import { DB } from './database.js';
import { AuthModule } from './auth.js';

function _currentUsername() {
  const session = AuthModule.getSession();
  return session?.username || '';
}

async function _getStats() {
  const username = _currentUsername();
  if (!username) return { owners: 0, offices: 0, receipts: 0, pending: 0 };

  const owners = (await DB.getAll('vehicleOwners')).filter(o => o.deleted_at === null).length;
  const offices = (await DB.getAll('offices')).filter(o => o.deleted_at === null && o.username === username).length;
  const allReceipts = (await DB.getAll('receipts')).filter(r => r.deleted_at === null && r.username === username);
  const receipts = allReceipts.length;
  const pending = allReceipts.filter(r => String(r.payout_status || 'unpaid') === 'unpaid').length;

  return { owners, offices, receipts, pending };
}

function _render(stats) {
  const page = document.getElementById('homePage');
  if (!page) return;

  page.innerHTML = `
    <!-- بطاقة الترحيب والإحصاء -->
    <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px;">
      <h2 style="font-size:1.75rem;font-weight:800;color:#1f2937;margin:0 0 6px;">مرحباً بك في نظام Karta</h2>
      <p style="color:#4b5563;font-size:0.9375rem;margin:0 0 20px;">نظام شامل لإدارة الكارتات وأصحاب المركبات والعملاء</p>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;">
        ${_statCard('أصحاب المركبات', stats.owners, 'linear-gradient(135deg,#3b82f6,#2563eb)', '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>')}
        ${_statCard('العملاء', stats.offices, 'linear-gradient(135deg,#22c55e,#16a34a)', '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>')}
        ${_statCard('إجمالي الكارتات', stats.receipts, 'linear-gradient(135deg,#a855f7,#7c3aed)', '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>')}
        ${_statCard('قيد الانتظار', stats.pending, 'linear-gradient(135deg,#f97316,#ea580c)', '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>')}
      </div>
    </div>

    <!-- البطاقتان السفليتان -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

      <!-- مميزات النظام -->
      <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;">
        <h3 style="font-size:1.25rem;font-weight:700;color:#1f2937;margin:0 0 16px;">مميزات النظام</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${_featureItem('إدارة شاملة لأصحاب المركبات والعملاء')}
          ${_featureItem('نموذج صرف احترافي مع حسابات تلقائية')}
          ${_featureItem('تتبع المديونيات والمدفوعات')}
          ${_featureItem('طباعة احترافية لجميع التقارير')}
          ${_featureItem('حفظ تلقائي للبيانات')}
          ${_featureItem('متوافق مع جميع الأجهزة')}
        </div>
      </div>

      <!-- البدء السريع -->
      <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;">
        <h3 style="font-size:1.25rem;font-weight:700;color:#1f2937;margin:0 0 16px;">البدء السريع</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${_stepItem(1, 'أضف أصحاب المركبات', 'ابدأ بإضافة بيانات أصحاب المركبات', '#3b82f6', '#eff6ff', 'ownersPage')}
          ${_stepItem(2, 'أضف العملاء', 'سجل بيانات العملاء الذين تتعامل معهم', '#22c55e', '#f0fdf4', 'officesPage')}
          ${_stepItem(3, 'أنشئ نماذج الصرف', 'قم بإنشاء وإدارة نماذج الصرف', '#7c3aed', '#f5f3ff', 'receipt')}
        </div>
      </div>

    </div>
  `;
}

function _statCard(label, value, gradient, svgPath) {
  return `
    <div style="background:${gradient};border-radius:14px;padding:18px;color:#fff;display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 12px rgba(0,0,0,0.12);">
      <div>
        <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">${label}</p>
        <p style="font-size:2rem;font-weight:800;margin:0;line-height:1;">${value}</p>
      </div>
      <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="opacity:0.5;">${svgPath}</svg>
    </div>`;
}

function _featureItem(text) {
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="color:#22c55e;font-size:1.125rem;font-weight:700;flex-shrink:0;line-height:1.4;">✓</span>
      <span style="color:#374151;font-size:0.875rem;line-height:1.6;">${text}</span>
    </div>`;
}

function _stepItem(num, title, desc, circleColor, bgColor, pageName) {
  return `
    <div data-action="home-navigate" data-page="${pageName}" style="background:${bgColor};border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:box-shadow 0.2s,transform 0.2s;" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)';this.style.transform='translateY(-1px)'" onmouseout="this.style.boxShadow='';this.style.transform=''">
      <div style="width:32px;height:32px;border-radius:50%;background:${circleColor};color:#fff;font-weight:700;font-size:0.875rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${num}</div>
      <div>
        <p style="font-weight:700;color:#1f2937;margin:0;font-size:0.9375rem;">${title}</p>
        <p style="color:#6b7280;margin:2px 0 0;font-size:0.8125rem;">${desc}</p>
      </div>
    </div>`;
}

let _bound = false;

function initHomePage() {
  if (!_bound) {
    _bound = true;
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-action="home-navigate"]');
      if (nav && typeof window.showPage === 'function') {
        window.showPage(nav.dataset.page);
      }
    });
  }

  _getStats().then(stats => _render(stats));
}

export { initHomePage };
