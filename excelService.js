/**
 * excelService.js — Unified Excel Import/Export Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all Excel operations in the Karta system.
 *
 * PUBLIC API:
 *   ExcelService.exportReceiptRows(rows, filename?)      → void (triggers download)
 *   ExcelService.importReceiptRows(file)                 → Promise<RowData[]>
 *
 *   ExcelService.exportBolsaRows(rows, filename?)        → void (triggers download)
 *   ExcelService.importBolsaRows(file)                   → Promise<RowData[]>
 *
 *   ExcelService.exportVehicleOwners(owners, filename?)  → void (triggers download)
 *   ExcelService.importVehicleOwners(file)               → Promise<{ name }[]>
 *
 *   ExcelService.exportEntitiesExcel({ owners, brokers }, filename?)
 *                                                        → void (triggers download)
 *   ExcelService.importEntitiesExcel(file)
 *                                                        → Promise<{ owners: {name,phone}[], brokers: {name,phone}[] }>
 *
 *   ExcelService.openFilePicker(callback)                → void
 *
 * RULES:
 *   - All XLSX logic lives here. Pages only call these functions.
 *   - openFilePicker is the only function that touches the DOM (unavoidable for file input).
 *   - No financial logic. No DB writes. Pure data transform.
 *   - Relies on SheetJS (XLSX) loaded globally via <script src="xlsx.full.min.js">.
 *   - MySQL-compatible: all field names match DB column names exactly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── INTERNAL: XLSX GUARD ─────────────────────────────────────────────────────

/**
 * Returns the global XLSX object (SheetJS).
 * Throws a clear error if the library is not loaded.
 */
function _xlsx() {
  if (typeof window === 'undefined' || !window.XLSX) {
    throw new Error('[ExcelService] SheetJS (XLSX) is not loaded. Ensure xlsx.full.min.js is included before this module.');
  }
  return window.XLSX;
}

// ─── INTERNAL: FILE DOWNLOAD ──────────────────────────────────────────────────

/**
 * Triggers a browser download of an XLSX workbook.
 *
 * @param {object} wb      - SheetJS workbook object
 * @param {string} filename - e.g. "كارتات_2026-06-01.xlsx"
 */
function _downloadWorkbook(wb, filename) {
  const XL = _xlsx();
  XL.writeFile(wb, filename);
}

// ─── INTERNAL: DATE SUFFIX ────────────────────────────────────────────────────

/**
 * Returns today's date as "YYYY-MM-DD" for use in filenames.
 */
function _todayLabel() {
  return new Date().toISOString().slice(0, 10);
}

// ─── INTERNAL: FILE READER ────────────────────────────────────────────────────

/**
 * Reads a File object as an ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function _readFileBuffer(file) {
  return new Promise((resolve, reject) => {
    if (!(file instanceof File)) {
      reject(new Error('[ExcelService] Expected a File object.'));
      return;
    }
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = ()  => reject(new Error('[ExcelService] Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

// ─── INTERNAL: FILE SIZE LIMIT ────────────────────────────────────────────────

/** Maximum allowed Excel file size (5 MB). */
const _MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// ─── INTERNAL: VALIDATE FILE TYPE & SIZE ──────────────────────────────────────

/**
 * Validates that a file is .xlsx or .xls and does not exceed the size limit.
 * Both checks run before any I/O to give the user an immediate, clear error.
 *
 * @param {File} file
 * @throws {Error} if type is invalid or file is too large
 */
function _assertExcelFile(file) {
  if (!(file instanceof File)) {
    throw new Error('الملف غير صالح. يرجى اختيار ملف Excel.');
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw new Error('نوع الملف غير مدعوم. يرجى اختيار ملف بامتداد .xlsx أو .xls فقط.');
  }
  if (file.size > _MAX_FILE_SIZE_BYTES) {
    throw new Error('حجم ملف Excel كبير جداً.\nالحد الأقصى المسموح هو 5MB.');
  }
}

// ─── INTERNAL: PARSE WORKBOOK ─────────────────────────────────────────────────

/**
 * Parses an Excel file buffer into an array of plain objects.
 * Uses the first sheet. Returns raw header-keyed rows.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ headers: string[], rows: object[] }}
 */
function _parseBuffer(buffer) {
  const XL = _xlsx();
  const wb = XL.read(buffer, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('الملف لا يحتوي على أوراق عمل.');
  const ws = wb.Sheets[sheetName];
  const rows = XL.utils.sheet_to_json(ws, { defval: '' });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

// ─── INTERNAL: SAFE NUMBER ────────────────────────────────────────────────────

/**
 * Converts any value to a safe number (0 if invalid/empty).
 */
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── INTERNAL: SAFE STRING ────────────────────────────────────────────────────

/**
 * Converts any value to a trimmed string ('' if null/undefined).
 */
function _str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ─── INTERNAL: EXCEL DATE PARSING & NORMALIZATION ────────────────────────────

const MONTH_MAP = {
  'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'مايو': 5, 'يونيو': 6,
  'يوليو': 7, 'أغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
  'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
  'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6, 'july': 7, 'jul': 7,
  'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'october': 10, 'oct': 10,
  'november': 11, 'nov': 11, 'december': 12, 'dec': 12
};

function isValidDate(y, m, d) {
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

function excelSerialToDateStr(serial) {
  const val = Number(serial);
  if (!Number.isFinite(val) || val <= 0) return '';
  
  let days = val;
  if (val >= 60) {
    days = val - 1;
  }
  const ms = (days - 1) * 24 * 60 * 60 * 1000;
  const baseDate = new Date(Date.UTC(1900, 0, 1));
  const date = new Date(baseDate.getTime() + ms);
  
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseImportedDate(value) {
  const str = String(value ?? '').trim();
  if (!str) {
    throw new Error('التاريخ فارغ أو غير موجود في الصف.');
  }

  // Check if Excel Serial Date
  if (/^\d+(\.\d+)?$/.test(str)) {
    const serial = parseFloat(str);
    const dateStr = excelSerialToDateStr(serial);
    if (!dateStr) {
      throw new Error(`تاريخ Excel التسلسلي غير صالح: ${str}`);
    }
    const parts = dateStr.split('-');
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (isValidDate(y, m, d)) {
      return dateStr;
    }
    throw new Error(`التاريخ الناتج من كود Excel غير منطقي: ${dateStr}`);
  }

  // Regex patterns
  const match1 = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match1) {
    const y = parseInt(match1[1], 10);
    const m = parseInt(match1[2], 10);
    const d = parseInt(match1[3], 10);
    if (isValidDate(y, m, d)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    throw new Error(`تاريخ غير منطقي: ${str}`);
  }

  const match2 = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match2) {
    const d = parseInt(match2[1], 10);
    const m = parseInt(match2[2], 10);
    const y = parseInt(match2[3], 10);
    if (isValidDate(y, m, d)) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    throw new Error(`تاريخ غير منطقي: ${str}`);
  }

  // Textual parsing (Arabic / English months)
  const clean = str.toLowerCase().replace(/\s+/g, ' ').trim();
  let foundMonthVal = null;
  for (const [mName, mVal] of Object.entries(MONTH_MAP)) {
    if (clean.includes(mName)) {
      foundMonthVal = mVal;
      break;
    }
  }

  if (foundMonthVal) {
    const numbers = clean.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      let y = 0, d = 0;
      const num1 = parseInt(numbers[0], 10);
      const num2 = parseInt(numbers[1], 10);
      if (numbers[0].length === 4) {
        y = num1;
        d = num2;
      } else if (numbers[1].length === 4) {
        y = num2;
        d = num1;
      } else {
        if (num1 > 100) { y = num1; d = num2; }
        else { y = num2; d = num1; }
      }

      if (isValidDate(y, foundMonthVal, d)) {
        return `${y}-${String(foundMonthVal).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }

  throw new Error(`صيغة التاريخ غير مدعومة أو غير صالحة: ${str}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: نموذج الصرف (Receipt Rows)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column definitions for receipt Excel export/import.
 * Mirrors COL_DEFS from receipts.js but scoped to this module.
 * Excludes: _actions (UI only), net & weightTotal (calculated by the form).
 *
 * key    → field name in stored row object (DB field)
 * header → Arabic column label shown in Excel header
 * type   → 'text' | 'number'
 */
const _RECEIPT_COLS = Object.freeze([
  { key: 'kartano',      header: 'رقم الكارتة',   type: 'text'   },
  { key: 'date',         header: 'التاريخ',        type: 'text'   },
  { key: 'data',         header: 'اسم السائق',     type: 'text'   },
  { key: 'car',          header: 'رقم المركبة',    type: 'text'   },
  { key: 'weight',       header: 'وزن وش',         type: 'number' },
  { key: 'weight2',      header: 'وزن م',          type: 'number' },
  { key: 'deficit',      header: 'عجز',            type: 'number' },
  { key: 'office',       header: 'اسم الشركة',     type: 'text'   },
  { key: 'loading',      header: 'التحميل',        type: 'text'   },
  { key: 'taktik',       header: 'الجهة',          type: 'text'   },
  { key: 'type',         header: 'النوع',          type: 'text'   },
  { key: 'noloon',       header: 'نولون',          type: 'number' },
  { key: 'ohda',         header: 'عهدة',           type: 'number' },
  { key: 'officeAmount', header: 'مكتب',           type: 'number' },
  { key: 'add',          header: 'إضافة',          type: 'number' },
  { key: 'discount',     header: 'خصم',           type: 'number' },
  { key: 'army',         header: 'جيش',           type: 'number' },
]);

// Full header list used in import validation error messages.
const _RECEIPT_REQUIRED_HEADERS = _RECEIPT_COLS.map(c => c.header);

/**
 * exportReceiptRows(rows, filename?)
 *
 * Exports data rows from the receipt form to Excel.
 * Skips separator rows (_type === 'separator') and calculated fields (net, weightTotal).
 * Triggers a browser download immediately.
 *
 * @param {object[]} rows     - Array of row data objects from the form/record
 * @param {string}  [filename]
 */
function exportReceiptRows(rows, filename) {
  const XL = _xlsx();

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('لا توجد صفوف بيانات للتصدير.');
  }

  // Filter out separator rows — export data rows only
  const dataRows = rows.filter(r => r && r._type !== 'separator');
  if (dataRows.length === 0) {
    throw new Error('لا توجد صفوف بيانات قابلة للتصدير (جميع الصفوف فواصل مركبات).');
  }

  // Build array of plain objects with Arabic headers
  const sheetData = dataRows.map(row => {
    const obj = {};
    for (const col of _RECEIPT_COLS) {
      const raw = row[col.key] ?? '';
      obj[col.header] = col.type === 'number'
        ? (raw === '' || raw === null || raw === undefined ? '' : _num(raw))
        : _str(raw);
    }
    return obj;
  });

  const ws = XL.utils.json_to_sheet(sheetData, { header: _RECEIPT_COLS.map(c => c.header) });
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'كارتات');

  _downloadWorkbook(wb, filename || `كارتات_${_todayLabel()}.xlsx`);
}

/**
 * importReceiptRows(file)
 *
 * Parses an Excel file and returns an array of row data objects
 * ready to be inserted into the receipt form.
 * Does NOT write to DB. Does NOT touch the DOM.
 *
 * @param {File} file - The uploaded .xlsx/.xls file
 * @returns {Promise<object[]>} Array of row objects (data rows only, no separators)
 */
async function importReceiptRows(file) {
  _assertExcelFile(file);

  const buffer = await _readFileBuffer(file);
  const { headers, rows } = _parseBuffer(buffer);

  // Validate: file must have at least one expected column
  const matchedCols = _RECEIPT_COLS.filter(col => headers.includes(col.header));
  if (matchedCols.length === 0) {
    throw new Error(
      `الملف لا يحتوي على أعمدة مطابقة.\n` +
      `الأعمدة المتوقعة: ${_RECEIPT_REQUIRED_HEADERS.join('، ')}`
    );
  }

  if (rows.length === 0) {
    throw new Error('الملف لا يحتوي على بيانات.');
  }

  // Map Excel rows → receipt row objects.
  // net and weightTotal are calculated fields — the import handler recomputes
  // them inline from the imported values before inserting rows into the form.
  const result = rows
    .filter(r => {
      // Skip fully empty rows
      return _RECEIPT_COLS.some(col => _str(r[col.header]) !== '');
    })
    .map(r => {
      const row = {};
      for (const col of _RECEIPT_COLS) {
        let cellVal = r[col.header] ?? '';
        if (col.key === 'date') {
          cellVal = parseImportedDate(cellVal);
        }
        row[col.key] = col.type === 'number'
          ? _num(cellVal)
          : _str(cellVal);
      }
      // net and weightTotal will be computed by the import handler from
      // the raw values above — no event dispatching needed.
      row.net         = 0;
      row.weightTotal = 0;
      row._type       = 'data';
      return row;
    });

  if (result.length === 0) {
    throw new Error('الملف لا يحتوي على صفوف بيانات صالحة بعد التصفية.');
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: تفريغ البوالص (Bolsa Rows)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column definitions for bolsa Excel export/import.
 * Mirrors _collectRow() and _rowTemplate() from bolsas.js exactly.
 */
const _BOLSA_COLS = Object.freeze([
  { key: 'kartaNo',    header: 'رقم الكارتة',    type: 'text'   },
  { key: 'rowdate',    header: 'التاريخ',         type: 'text'   },
  { key: 'driver',     header: 'اسم السائق',      type: 'text'   },
  { key: 'owner_name', header: 'صاحب المركبة',   type: 'text'   },
  { key: 'carNo',      header: 'رقم المركبة',     type: 'text'   },
  { key: 'weight',     header: 'وزن وش',          type: 'number' },
  { key: 'office',     header: 'اسم الشركة',      type: 'text'   },
  { key: 'loading',    header: 'التحميل',         type: 'text'   },
  { key: 'direction',  header: 'الجهة',           type: 'text'   },
  { key: 'type',       header: 'النوع',           type: 'text'   },
  { key: 'ohda',       header: 'العهدة',          type: 'number' },
  { key: 'dokhan',     header: 'اكرامية',         type: 'number' },
  { key: 'noloon',     header: 'نولون',           type: 'number' },
  { key: 'solar',      header: 'سولار',           type: 'number' },
  { key: 'notes',      header: 'ملاحظات',         type: 'text'   },
]);

const _BOLSA_REQUIRED_HEADERS = _BOLSA_COLS.map(c => c.header);

/**
 * exportBolsaRows(rows, filename?)
 *
 * Exports bolsa form rows to Excel.
 * Uses the raw row objects from the form or a saved record.
 *
 * @param {object[]} rows
 * @param {string}  [filename]
 */
function exportBolsaRows(rows, filename) {
  const XL = _xlsx();

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('لا توجد صفوف بيانات للتصدير.');
  }

  const sheetData = rows.map(row => {
    const obj = {};
    for (const col of _BOLSA_COLS) {
      const raw = row[col.key] ?? '';
      obj[col.header] = col.type === 'number'
        ? (raw === '' || raw === null ? '' : _num(raw))
        : _str(raw);
    }
    return obj;
  });

  const ws = XL.utils.json_to_sheet(sheetData, { header: _BOLSA_COLS.map(c => c.header) });
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'بوالص');

  _downloadWorkbook(wb, filename || `بوالص_${_todayLabel()}.xlsx`);
}

/**
 * importBolsaRows(file)
 *
 * Parses an Excel file and returns bolsa row objects.
 * Does NOT save to DB. Does NOT touch the DOM.
 *
 * @param {File} file
 * @returns {Promise<object[]>}
 */
async function importBolsaRows(file) {
  _assertExcelFile(file);

  const buffer = await _readFileBuffer(file);
  const { headers, rows } = _parseBuffer(buffer);

  const matchedCols = _BOLSA_COLS.filter(col => headers.includes(col.header));
  if (matchedCols.length === 0) {
    throw new Error(
      `الملف لا يحتوي على أعمدة مطابقة.\n` +
      `الأعمدة المتوقعة: ${_BOLSA_REQUIRED_HEADERS.join('، ')}`
    );
  }

  if (rows.length === 0) {
    throw new Error('الملف لا يحتوي على بيانات.');
  }

  const result = rows
    .filter(r => _BOLSA_COLS.some(col => _str(r[col.header]) !== ''))
    .map(r => {
      const row = {};
      for (const col of _BOLSA_COLS) {
        let cellVal = r[col.header] ?? '';
        if (col.key === 'rowdate') {
          cellVal = parseImportedDate(cellVal);
        }
        row[col.key] = col.type === 'number' ? _num(cellVal) : _str(cellVal);
      }
      row.weight2 = 0; // weight2 not in bolsa form — always 0
      return row;
    });

  if (result.length === 0) {
    throw new Error('الملف لا يحتوي على صفوف بيانات صالحة بعد التصفية.');
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: أصحاب المركبات (Vehicle Owners)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * exportVehicleOwners(owners, filename?)
 *
 * Exports only the names of vehicle owners to Excel.
 * Per spec: names only — no balance, no karta count, no actions.
 *
 * @param {{ name: string }[]} owners
 * @param {string} [filename]
 */
function exportVehicleOwners(owners, filename) {
  const XL = _xlsx();

  if (!Array.isArray(owners) || owners.length === 0) {
    throw new Error('لا توجد أسماء للتصدير.');
  }

  const sheetData = owners
    .filter(o => o && _str(o.name))
    .map(o => ({ 'اسم صاحب المركبة': _str(o.name) }));

  if (sheetData.length === 0) {
    throw new Error('لا توجد أسماء صالحة للتصدير.');
  }

  const ws = XL.utils.json_to_sheet(sheetData, { header: ['اسم صاحب المركبة'] });
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'أصحاب المركبات');

  _downloadWorkbook(wb, filename || `اصحاب_المركبات_${_todayLabel()}.xlsx`);
}

/**
 * importVehicleOwners(file)
 *
 * Parses an Excel file and returns an array of { name } objects.
 * - Skips empty rows automatically.
 * - Deduplicates names within the file.
 * - Does NOT save to DB. The caller handles DB writes.
 *
 * @param {File} file
 * @returns {Promise<{ name: string }[]>}
 */
async function importVehicleOwners(file) {
  _assertExcelFile(file);

  const buffer = await _readFileBuffer(file);
  const { headers, rows } = _parseBuffer(buffer);

  if (rows.length === 0) {
    throw new Error('الملف لا يحتوي على بيانات.');
  }

  // The column name must match exactly. No fallback — a wrong column could
  // silently import garbage data into the DB.
  const NAME_HEADER = 'اسم صاحب المركبة';
  if (!headers.includes(NAME_HEADER)) {
    throw new Error(
      `الملف لا يحتوي على العمود المطلوب: "${NAME_HEADER}".\n` +
      `تأكد من استخدام ملف مُصدَّر من النظام أو ملف يحتوي على نفس اسم العمود.`
    );
  }
  const nameKey = NAME_HEADER;

  const seen = new Set();
  const result = [];

  for (const r of rows) {
    const name = _str(r[nameKey]);
    if (!name) continue;                 // skip empty
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;       // deduplicate within file
    seen.add(lower);
    result.push({ name });
  }

  if (result.length === 0) {
    throw new Error('الملف لا يحتوي على أسماء صالحة بعد التصفية.');
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3.5: كشف حساب العملاء — أصحاب المركبات + الوسطاء (ملف واحد)
// ─────────────────────────────────────────────────────────────────────────────
//
// One Excel file with FOUR columns (note: two columns share the same header
// "رقم الهاتف", which would collide if we used object-keyed json_to_sheet —
// hence the AOA approach below):
//
//   | اسم صاحب المركبة | رقم الهاتف | اسم الوسيط | رقم الهاتف |
//
// Rules:
//   - Each row may contain owner only, broker only, or both — they are NOT
//     paired logically; they share rows purely for compact presentation.
//   - Fully empty rows are skipped on import.
//   - Within-file deduplication is case-insensitive (trimmed name).
//   - DB-level duplicate handling (skip with phone-mismatch, etc.) is the
//     caller's responsibility — this service stays pure.
//

/** Header labels for the combined entities sheet — order matters. */
const _ENTITIES_HEADERS = Object.freeze([
  'اسم صاحب المركبة',
  'رقم الهاتف',
  'اسم الوسيط',
  'رقم الهاتف',
]);

/** Fixed column indexes inside the AOA structure. */
const _ENT_COL_OWNER_NAME   = 0;
const _ENT_COL_OWNER_PHONE  = 1;
const _ENT_COL_BROKER_NAME  = 2;
const _ENT_COL_BROKER_PHONE = 3;

/**
 * exportEntitiesExcel({ owners, brokers }, filename?)
 *
 * Exports vehicle owners + brokers into ONE Excel file with the 4-column
 * layout above. Owners and brokers are written independently, sharing rows
 * only to keep the sheet compact; no relationship is implied between an
 * owner and the broker on the same row.
 *
 * @param {{ owners?: {name:string, phone?:string|null}[],
 *           brokers?: {name:string, phone?:string|null}[] }} payload
 * @param {string} [filename]
 */
function exportEntitiesExcel(payload, filename) {
  const XL = _xlsx();

  const ownersIn  = Array.isArray(payload?.owners)  ? payload.owners  : [];
  const brokersIn = Array.isArray(payload?.brokers) ? payload.brokers : [];

  // Clean & filter: keep only entries with a non-empty trimmed name.
  const owners = ownersIn
    .map(o => ({ name: _str(o?.name), phone: _str(o?.phone) }))
    .filter(o => o.name);

  const brokers = brokersIn
    .map(b => ({ name: _str(b?.name), phone: _str(b?.phone) }))
    .filter(b => b.name);

  if (owners.length === 0 && brokers.length === 0) {
    throw new Error('لا توجد أسماء للتصدير.');
  }

  // Build AOA: header row + data rows.
  const rowCount = Math.max(owners.length, brokers.length);
  const aoa = [ _ENTITIES_HEADERS.slice() ];
  for (let i = 0; i < rowCount; i++) {
    const o = owners[i];
    const b = brokers[i];
    const row = ['', '', '', ''];
    if (o) {
      row[_ENT_COL_OWNER_NAME]  = o.name;
      row[_ENT_COL_OWNER_PHONE] = o.phone || '';
    }
    if (b) {
      row[_ENT_COL_BROKER_NAME]  = b.name;
      row[_ENT_COL_BROKER_PHONE] = b.phone || '';
    }
    aoa.push(row);
  }

  const ws = XL.utils.aoa_to_sheet(aoa);
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'كشف حساب العملاء');

  _downloadWorkbook(wb, filename || `كشف_حساب_العملاء_${_todayLabel()}.xlsx`);
}

/**
 * importEntitiesExcel(file)
 *
 * Parses a 4-column Excel file into separate owner + broker lists.
 * Reads via AOA because two columns share the same header label
 * ("رقم الهاتف"), which would collapse into a single key under
 * sheet_to_json's default object mode.
 *
 * Skips fully empty rows. Deduplicates within the file (case-insensitive
 * on trimmed name). DB-level duplicate handling is the caller's concern.
 *
 * @param {File} file
 * @returns {Promise<{ owners: {name:string, phone:string}[],
 *                     brokers: {name:string, phone:string}[] }>}
 */
async function importEntitiesExcel(file) {
  _assertExcelFile(file);

  const XL = _xlsx();
  const buffer = await _readFileBuffer(file);
  const wb = XL.read(buffer, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('الملف لا يحتوي على أوراق عمل.');
  const ws = wb.Sheets[sheetName];

  // AOA mode preserves columns with duplicate headers.
  const aoa = XL.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });

  if (!Array.isArray(aoa) || aoa.length === 0) {
    throw new Error('الملف لا يحتوي على بيانات.');
  }

  // First row = header. Locate columns by header label so we tolerate
  // small reorderings — but only when both phone columns appear after
  // their respective name columns.
  const headerRow = (aoa[0] || []).map(_str);

  let ownerNameCol  = headerRow.indexOf('اسم صاحب المركبة');
  let brokerNameCol = headerRow.indexOf('اسم الوسيط');

  if (ownerNameCol === -1 && brokerNameCol === -1) {
    throw new Error(
      'الملف لا يحتوي على الأعمدة المطلوبة.\n' +
      'الأعمدة المتوقعة: ' + _ENTITIES_HEADERS.join('، ')
    );
  }

  // Phone columns: take the first "رقم الهاتف" header strictly to the
  // right of each name column. Fallback to fixed positions if needed.
  function _nextPhoneAfter(idx) {
    if (idx < 0) return -1;
    for (let i = idx + 1; i < headerRow.length; i++) {
      if (headerRow[i] === 'رقم الهاتف') return i;
    }
    return -1;
  }

  let ownerPhoneCol  = _nextPhoneAfter(ownerNameCol);
  let brokerPhoneCol = _nextPhoneAfter(brokerNameCol);

  // Last-resort fallback: assume the canonical column order if a name
  // column was found but its phone column wasn't.
  if (ownerNameCol  !== -1 && ownerPhoneCol  === -1) ownerPhoneCol  = ownerNameCol  + 1;
  if (brokerNameCol !== -1 && brokerPhoneCol === -1) brokerPhoneCol = brokerNameCol + 1;

  const owners  = [];
  const brokers = [];
  const seenOwners  = new Set();
  const seenBrokers = new Set();

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];

    // Skip fully empty rows.
    const hasAny = row.some(cell => _str(cell) !== '');
    if (!hasAny) continue;

    if (ownerNameCol !== -1) {
      const name  = _str(row[ownerNameCol]);
      const phone = ownerPhoneCol !== -1 ? _str(row[ownerPhoneCol]) : '';
      if (name) {
        const key = name.toLowerCase();
        if (!seenOwners.has(key)) {
          seenOwners.add(key);
          owners.push({ name, phone });
        }
      }
    }

    if (brokerNameCol !== -1) {
      const name  = _str(row[brokerNameCol]);
      const phone = brokerPhoneCol !== -1 ? _str(row[brokerPhoneCol]) : '';
      if (name) {
        const key = name.toLowerCase();
        if (!seenBrokers.has(key)) {
          seenBrokers.add(key);
          brokers.push({ name, phone });
        }
      }
    }
  }

  if (owners.length === 0 && brokers.length === 0) {
    throw new Error('الملف لا يحتوي على أسماء صالحة بعد التصفية.');
  }

  return { owners, brokers };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: جميع النماذج — تصدير كل صفوف الكارتات المعروضة
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column definitions for the "all receipts" flat export.
 * Each row in the output represents ONE data row from ONE receipt.
 * Columns are fixed in the order specified by the product requirements.
 *
 * Money semantics:
 *   - Row-level numeric fields (net, ohda, noloon, officeAmount, add,
 *     weight, weight2, deficit, weightTotal) → stored as DECIMALS.
 *   - Exported as-is (no conversion needed).
 *
 * "صاحب المركبة" comes from the parent record (record.owner_name ||
 *  record.client_name), not from the row itself — it is injected per row.
 */
const _ALL_RECEIPTS_COLS = Object.freeze([
  { header: 'رقم الكارتة',  getValue: (row, _rec) => _str(row.kartano ?? row.kartaNo ?? row.karta ?? '') },
  { header: 'التاريخ',       getValue: (row, _rec) => _str(row.date ?? row.rowdate ?? '') },
  { header: 'اسم السائق',   getValue: (row, _rec) => _str(row.data ?? row.driver ?? '') },
  { header: 'صاحب المركبة', getValue: (_row, rec)  => _str(rec.owner_name ?? rec.client_name ?? '') },
  { header: 'رقم المركبة',  getValue: (row, _rec) => _str(row.car ?? row.vehicle_plate ?? row.carNo ?? '') },
  { header: 'وزن وش',        getValue: (row, _rec) => _allReceiptsNum(row.weight) },
  { header: 'وزن م',         getValue: (row, _rec) => _allReceiptsNum(row.weight2) },
  { header: 'عجز',           getValue: (row, _rec) => _allReceiptsNum(row.deficit) },
  {
    header: 'الوزن',
    getValue: (row, _rec) => {
      // weightTotal may be pre-calculated or absent (legacy records)
      if (row.weightTotal != null && row.weightTotal !== '') return _allReceiptsNum(row.weightTotal);
      if (row.weight_total != null && row.weight_total !== '') return _allReceiptsNum(row.weight_total);
      const w1 = Number(row.weight)  || 0;
      const w2 = Number(row.weight2) || 0;
      const d  = Number(row.deficit) || 0;
      return (w1 > 0 || w2 > 0) ? _allReceiptsNum(w1 + w2 - d) : '';
    },
  },
  { header: 'اسم الشركة',   getValue: (row, _rec) => _str(row.office ?? '') },
  { header: 'التحميل',      getValue: (row, _rec) => _str(row.loading ?? '') },
  { header: 'الجهة',        getValue: (row, _rec) => _str(row.taktik ?? row.direction ?? '') },
  { header: 'النوع',        getValue: (row, _rec) => _str(row.type ?? '') },
  { header: 'نولون',        getValue: (row, _rec) => _allReceiptsNum(row.noloon) },
  { header: 'عهدة',         getValue: (row, _rec) => _allReceiptsNum(row.ohda) },
  { header: 'مكتب',         getValue: (row, _rec) => _allReceiptsNum(row.officeAmount) },
  { header: 'اضافة',        getValue: (row, _rec) => _allReceiptsNum(row.add) },
  { header: 'خصم',         getValue: (row, _rec) => _allReceiptsNum(row.discount) },
  { header: 'جيش',         getValue: (row, _rec) => _allReceiptsNum(row.army) },
  { header: 'الصافي',       getValue: (row, _rec) => _allReceiptsNum(row.net) },
]);

/**
 * Safe number extractor for the flat export.
 * Returns the number as-is if valid, or '' for empty/missing values.
 * Row-level money fields are already in decimal format (not cents).
 */
function _allReceiptsNum(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

/**
 * exportAllReceiptsRows(receiptsWithRows, filename?)
 *
 * Builds a single flat Excel sheet where every row represents one
 * data row from one receipt.  Separator rows (_type === 'separator')
 * are excluded.  The parent receipt's owner name is injected into
 * every child row under the "صاحب المركبة" column.
 *
 * The caller is responsible for:
 *   1. Filtering records to those currently visible (after search/filter).
 *   2. Sorting records in display order.
 *   3. For each record, providing only the rows that are visible
 *      (i.e. already filtered by row-level search terms).
 *
 * @param {Array<{ record: object, rows: object[] }>} receiptsWithRows
 *   Each element carries the parent receipt record and its visible rows.
 * @param {string} [filename]
 */
function exportAllReceiptsRows(receiptsWithRows, filename) {
  const XL = _xlsx();

  if (!Array.isArray(receiptsWithRows) || receiptsWithRows.length === 0) {
    throw new Error('لا توجد نماذج للتصدير.');
  }

  // Build flat array of plain objects — one per data row
  const sheetData = [];

  for (const { record, rows } of receiptsWithRows) {
    if (!record || !Array.isArray(rows)) continue;

    // Only data rows — skip separators and any malformed entries
    const dataRows = rows.filter(r => r && r._type !== 'separator');
    if (dataRows.length === 0) continue;

    for (const row of dataRows) {
      const excelRow = {};
      for (const col of _ALL_RECEIPTS_COLS) {
        excelRow[col.header] = col.getValue(row, record);
      }
      sheetData.push(excelRow);
    }
  }

  if (sheetData.length === 0) {
    throw new Error('لا توجد صفوف بيانات قابلة للتصدير.');
  }

  const headers = _ALL_RECEIPTS_COLS.map(c => c.header);
  const ws = XL.utils.json_to_sheet(sheetData, { header: headers });
  const wb = XL.utils.book_new();
  XL.utils.book_append_sheet(wb, ws, 'جميع النماذج');

  _downloadWorkbook(wb, filename || `جميع_النماذج_${_todayLabel()}.xlsx`);
}

// ─── END SECTION 4 ────────────────────────────────────────────────────────────

/**
 * openFilePicker(callback)
 *
 * Creates a hidden <input type="file">, opens the OS file dialog, and calls
 * callback(File) when the user selects a valid file.
 *
 * Race-condition safe:
 *   On some browsers the window 'focus' event fires before the input 'change'
 *   event when the user picks a file (the file dialog closes → window regains
 *   focus → 'change' fires a moment later).  A shared `handled` flag ensures
 *   only one path (change OR cancel-cleanup) ever executes, and the input
 *   element is removed exactly once regardless of event ordering.
 *
 * Async-callback safe:
 *   callback may be an async function.  Any rejection it produces is caught
 *   here and re-thrown as an unhandled rejection so the browser DevTools shows
 *   it clearly instead of silently swallowing it.
 *
 * @param {function(File): (void|Promise<void>)} callback
 */
function openFilePicker(callback) {
  // Shared flag — ensures both the 'change' path and the cancel-cleanup path
  // are mutually exclusive.  Once either runs, the other becomes a no-op.
  let handled = false;

  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.xlsx,.xls';
  input.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(input);

  // ── Cleanup helper — idempotent ──────────────────────────────────────────
  function _cleanup() {
    try { input.remove(); } catch (_) {}
  }

  // ── File selected ────────────────────────────────────────────────────────
  input.addEventListener('change', () => {
    if (handled) return;
    handled = true;
    _cleanup();

    const file = input.files?.[0];
    if (!file) return; // dialog opened but no file chosen via change event

    // Support async callbacks: catch any rejection and surface it as an
    // unhandled promise rejection so DevTools can show it.
    try {
      const result = callback(file);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => { throw err; });
      }
    } catch (err) {
      // Synchronous throw from callback — rethrow outside the event handler
      // so it isn't swallowed by the browser's event-listener error handling.
      Promise.reject(err);
    }
  });

  // ── User cancelled (window regains focus without a 'change' event) ───────
  // We use a 700ms delay — longer than the race window on slow machines —
  // so 'change' always has time to fire first when a file was actually chosen.
  window.addEventListener('focus', function onFocus() {
    window.removeEventListener('focus', onFocus);
    setTimeout(() => {
      if (!handled) {
        handled = true;
        _cleanup();
        // No callback — user cancelled.
      }
    }, 700);
  }, { once: true });

  input.click();
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

const ExcelService = Object.freeze({
  // Receipt rows (single form)
  exportReceiptRows,
  importReceiptRows,

  // Bolsa rows
  exportBolsaRows,
  importBolsaRows,

  // Vehicle owners (legacy — names-only, single column)
  exportVehicleOwners,
  importVehicleOwners,

  // Customer accounts page — owners + brokers in one file (4 columns)
  exportEntitiesExcel,
  importEntitiesExcel,

  // All receipts flat export (جميع النماذج)
  exportAllReceiptsRows,

  // Utility
  openFilePicker,
});

export { ExcelService };
