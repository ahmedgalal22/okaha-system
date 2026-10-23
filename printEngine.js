/**
 * printEngine.js — Unified Print Engine
 * Standard print architecture for the entire system.
 * Uses hidden iframe + document.write + isolated document.
 *
 * Usage:
 *   import { printHTML } from './printEngine.js';
 *   printHTML(htmlString);
 *   // or
 *   printHTML(buildPrintDocument({ title, body, orientation }));
 */

// ─── CORE PRINT FUNCTION ───────────────────────────────────────────────────────

/**
 * Print an HTML string via hidden iframe.
 * Safe, isolated, no popups, no window.open.
 *
 * @param {string} html - Complete HTML document to print
 * @param {object} [options] - { id: 'custom-id', delay: 600, cleanup: 3000 }
 */
function printHTML(html, options = {}) {
  const id = options.id || 'karta-print-iframe';
  const delay = options.delay || 600;
  const cleanupDelay = options.cleanup || 3000;

  // Remove any existing print iframe
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  // Create hidden iframe
  const iframe = document.createElement('iframe');
  iframe.id = id;
  iframe.style.cssText = 'position:fixed;top:0;left:-9999px;width:1100px;height:800px;border:none;opacity:0;pointer-events:none;';
  document.body.appendChild(iframe);

  // Write content
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }

  doc.open();
  doc.write(html);
  doc.close();

  // Print with double-guard (onload + fallback)
  let printed = false;

  function safePrint() {
    if (printed) return;
    printed = true;
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error('[printEngine]', e);
    }
    // Cleanup after print
    setTimeout(() => {
      try { iframe.remove(); } catch (_) {}
    }, cleanupDelay);
  }

  iframe.onload = safePrint;
  setTimeout(safePrint, delay);
}

// ─── DOCUMENT BUILDER ──────────────────────────────────────────────────────────

/**
 * Build a complete self-contained print HTML document.
 *
 * @param {object} opts
 * @param {string} opts.title - Document title
 * @param {string} opts.body - HTML body content
 * @param {string} [opts.orientation='landscape'] - 'landscape' | 'portrait'
 * @param {string} [opts.extraCSS=''] - Additional CSS rules
 * @returns {string} Complete HTML document
 */
function buildPrintDocument({ title = 'طباعة', body = '', orientation = 'landscape', extraCSS = '' }) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<title>${_escPrint(title)}</title>
<link rel="stylesheet" href="cairo-font.css">
<style>
${PRINT_BASE_CSS}
@page { size: A4 ${orientation}; margin: 10mm; }
${extraCSS}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ─── SHARED PRINT CSS ──────────────────────────────────────────────────────────

const PRINT_BASE_CSS = `
* { box-sizing: border-box; }
body {
  font-family: 'Cairo', Arial, sans-serif;
  direction: rtl;
  margin: 0;
  padding: 15mm;
  background: #fff;
  color: #000;
  font-size: 10pt;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
  page-break-inside: auto;
}
tr { page-break-inside: avoid; }
th, td {
  border: 1px solid #000;
  padding: 4px 6px;
  font-size: 9pt;
  vertical-align: middle;
}
thead {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h2 { margin: 0; }
.print-header {
  text-align: center;
  margin-bottom: 14px;
  border-bottom: 2px solid #1e3a8a;
  padding-bottom: 10px;
}
.print-header h2 { color: #1e3a8a; font-size: 16pt; }
.print-header-info {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 10pt;
}
.print-th {
  background: #1e3a8a;
  color: #fff;
  padding: 6px 8px;
  font-size: 9pt;
  text-align: center;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.print-th-emerald {
  background: #0f766e;
  color: #fff;
  padding: 6px 8px;
  font-size: 9pt;
  text-align: center;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.print-separator td {
  background: #fff7ed;
  border-top: 2px solid #fb923c;
  color: #9a3412;
  font-weight: 700;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.print-totals-row {
  display: flex;
  gap: 6px;
  margin-top: 12px;
  page-break-inside: avoid;
}
.print-totals-card {
  flex: 1;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  overflow: hidden;
}
.print-totals-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.print-totals-cell {
  padding: 8px;
  text-align: center;
  border: 1px solid #cbd5e1;
  color: #fff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.print-totals-cell .label { font-size: 8pt; opacity: 0.9; }
.print-totals-cell .value { font-size: 14pt; font-weight: bold; }
.print-note {
  margin-top: 12px;
  padding: 8px 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 10pt;
}
.print-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  padding: 8px 0 0;
  border-top: 1px solid #e5e7eb;
  font-size: 9pt;
  color: #374151;
}
.print-footer strong { font-weight: 800; }
`;

// ─── UTILITY ───────────────────────────────────────────────────────────────────

function _escPrint(v) {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

export { printHTML, buildPrintDocument, PRINT_BASE_CSS, _escPrint };
