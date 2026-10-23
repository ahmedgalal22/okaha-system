/**
 * database.js — IndexedDB layer (Phase 1)
 * Public API: DB.* — unchanged for MySQL migration (Phase 2)
 */

/**
 * database.js — IndexedDB Abstraction Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 1: IndexedDB implementation.
 * PHASE 2: Replace internals only — public API (DB.*) stays identical.
 *
 * PUBLIC API (never changes between phases):
 *   DB.getAll(store, filters?)       → Promise<Array>
 *   DB.getById(store, id)            → Promise<Object|null>
 *   DB.getByIndex(store, index, val) → Promise<Array>
 *   DB.add(store, payload, meta)     → Promise<Object>       ← injects meta fields
 *   DB.update(store, id, patch, meta)→ Promise<Object>
 *   DB.delete(store, id, meta)       → Promise<Object>       ← soft-delete
 *   DB.hardDelete(store, id)         → Promise<void>         ← permanent (rare)
 *   DB.transaction(ops, meta)        → Promise<Array>        ← atomic batch
 *   DB.transaction(async (tx) => {}, meta)
 *                                      → Promise<*>          ← scoped reads/writes
 *   DB.findByFields(store, filters)  → Promise<Array>
 *
 * STORES / SCHEMA defined in DB.STORES below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DB = (() => {

  // ─── CONFIGURATION ──────────────────────────────────────────────────────────

  const DB_NAME    = 'FinancialOpsDB';
  const DB_VERSION = 8;              // bumped: recreate bolsa stores deleted by the reverted v7 change

  /**
   * STORES schema.
   * Each entry: { name, keyPath, autoIncrement, indexes }
   * indexes: [{ name, keyPath, options }]
   */
  const STORES = {

    users: {
      name: 'users',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_username', keyPath: 'username', options: { unique: true } },
        { name: 'by_deleted',  keyPath: 'deleted_at' },
      ],
    },

    counters: {
      name: 'counters',
      keyPath: 'id',
      autoIncrement: false,
      indexes: [
        { name: 'by_deleted', keyPath: 'deleted_at' },
      ],
    },

    vehicles: {
      name: 'vehicles',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_plate',    keyPath: 'plate',      options: { unique: false } },
        { name: 'by_office',   keyPath: 'office_id',  options: { unique: false } },
        { name: 'by_deleted',  keyPath: 'deleted_at' },
      ],
    },

    /**
     * vehicle_ledger: one row per financial event on a vehicle
     * Fields: vehicle_id, receipt_id, type (credit|debit), amount, balance_after, note
     */
    /**
     * vehicle_ledger: one normalised row per financial event on a vehicle.
     *
     * Key fields:
     *   vehicle_id      : FK → vehicles.id
     *   type            : 'deposit' | 'withdraw'
     *   effect          : 'receipt_total' | 'receipt_payment'  (report filter key)
     *   amount          : number  (RULE 6)
     *   reference_type  : e.g. 'receipt'
     *   reference_id    : UUID of the source receipt
     *   date            : ISO date  (transaction date — when it happened)
     *   applied_at      : ISO datetime (execution date — when it was written to DB)
     *   is_reversed     : boolean
     *   reversed_at     : ISO datetime | null
     *   reversed_by     : username | null
     *
     * Compound index [reference_id, is_reversed]:
     *   Supports the hot query "give me all ACTIVE entries for receipt X"
     *   without a full-store scan or post-filter in JS.
     *   IndexedDB compound index uses Array keyPath — queried with IDBKeyRange.only([id, false]).
     */
    vehicle_ledger: {
      name: 'vehicle_ledger',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_vehicle',            keyPath: 'vehicle_id',                      options: { unique: false } },
        { name: 'by_reference_id',       keyPath: 'reference_id',                    options: { unique: false } },
        { name: 'by_reference_type',     keyPath: 'reference_type',                  options: { unique: false } },
        { name: 'by_effect',             keyPath: 'effect',                          options: { unique: false } },
        { name: 'by_type',               keyPath: 'type',                            options: { unique: false } },
        { name: 'by_is_reversed',        keyPath: 'is_reversed',                     options: { unique: false } },
        { name: 'by_ref_active',         keyPath: ['reference_id', 'is_reversed'],   options: { unique: false } },
        { name: 'by_deleted',            keyPath: 'deleted_at' },
      ],
    },

    offices: {
      name: 'offices',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_name',    keyPath: 'name',    options: { unique: true } },
        { name: 'by_deleted', keyPath: 'deleted_at' },
      ],
    },

    /**
     * receipts: money collected from clients / agents
     * Fields: vehicle_id, office_id, agent_id, amount, currency,
     *         receipt_type (cash|bolsa|transfer), reference_no, notes
     */
  receipts: {
  name: 'receipts',
  keyPath: 'id',
  autoIncrement: false,
  indexes: [
    { name: 'by_vehicle',  keyPath: 'vehicle_id',     options: { unique: false } },
    { name: 'by_office',   keyPath: 'office_id',      options: { unique: false } },
    { name: 'by_agent',    keyPath: 'agent_id',       options: { unique: false } },
    { name: 'by_type',     keyPath: 'receipt_type',   options: { unique: false } },
    { name: 'by_number',   keyPath: 'receipt_number', options: { unique: true  } },
    { name: 'by_deleted',  keyPath: 'deleted_at' },
  ],
},

    /**
     * bolsa: hawala / informal transfer records
     * Fields: sender_id (agent), receiver_id (agent|office), amount,
     *         currency, status (pending|settled|cancelled), settled_at
     */
    bolsa: {
      name: 'bolsa',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_sender',   keyPath: 'sender_id',   options: { unique: false } },
        { name: 'by_receiver', keyPath: 'receiver_id', options: { unique: false } },
        { name: 'by_status',   keyPath: 'status',      options: { unique: false } },
        { name: 'by_deleted',  keyPath: 'deleted_at' },
      ],
    },

    /**
     * treasury: master cash ledger (single source of truth for cash flow)
     * Fields: entry_type (receipt|expense|transfer|adjustment),
     *         direction (in|out), amount, currency, reference_id,
     *         reference_store, balance_after, note
     */
    /**
     * treasury: master cash ledger — single source of truth for cash flow.
     *
     * Key fields:
     *   type            : 'withdraw' | 'deposit' | 'adjustment'
     *   effect          : 'receipt_payment' | ...  (report filter key)
     *   amount          : number  (RULE 6)
     *   account_type    : 'cash' | 'bank' | 'vodafone'
     *   reference_type  : e.g. 'receipt'
     *   reference_id    : UUID of the source document
     *   date            : ISO date  (transaction date)
     *   applied_at      : ISO datetime (execution date — when written to DB)
     *   is_reversed     : boolean
     *   reversed_at     : ISO datetime | null
     *   reversed_by     : username | null
     *
     * Compound index [reference_id, is_reversed]:
     *   Same pattern as vehicle_ledger — fast active-entry lookup per receipt.
     */
    treasury: {
      name: 'treasury',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_entry_type',         keyPath: 'entry_type',                      options: { unique: false } },
        { name: 'by_type',               keyPath: 'type',                            options: { unique: false } },
        { name: 'by_effect',             keyPath: 'effect',                          options: { unique: false } },
        { name: 'by_account_type',       keyPath: 'account_type',                    options: { unique: false } },
        { name: 'by_reference_id',       keyPath: 'reference_id',                    options: { unique: false } },
        { name: 'by_reference_type',     keyPath: 'reference_type',                  options: { unique: false } },
        { name: 'by_is_reversed',        keyPath: 'is_reversed',                     options: { unique: false } },
        { name: 'by_ref_active',         keyPath: ['reference_id', 'is_reversed'],   options: { unique: false } },
        { name: 'by_deleted',            keyPath: 'deleted_at' },
      ],
    },

    agents: {
      name: 'agents',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_name',    keyPath: 'name',      options: { unique: false } },
        { name: 'by_office',  keyPath: 'office_id', options: { unique: false } },
        { name: 'by_deleted', keyPath: 'deleted_at' },
      ],
    },

    notes: {
      name: 'notes',
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'by_related_store', keyPath: 'related_store', options: { unique: false } },
        { name: 'by_related_id',    keyPath: 'related_id',    options: { unique: false } },
        { name: 'by_deleted',       keyPath: 'deleted_at' },
      ],
    },

    /**
     * vehicleOwners: owners linked to a username (multi-tenant).
     * Used by receipt-page.js for the owner datalist + balance lookup.
     *
     * Key fields:
     *   username : FK → users.username
     *   name     : display name (must be unique per username)
     *   id       : UUID string (autoIncrement: false)
     */
    vehicleOwners: {
      name          : 'vehicleOwners',
      keyPath       : 'id',
      autoIncrement : false,            // UUID pre-generated by caller
      indexes: [
        { name: 'by_username', keyPath: 'username', options: { unique: false } },
        { name: 'by_name',     keyPath: 'name',     options: { unique: false } },
        { name: 'by_deleted',  keyPath: 'deleted_at' },
      ],
    },

    /**
     * drivers: driver names saved from receipt rows.
     * Used to populate the driversList datalist in the receipt table.
     *
     * Key fields:
     *   username : FK → users.username
     *   name     : driver display name
     */
    drivers: {
      name          : 'drivers',
      keyPath       : 'id',
      autoIncrement : true,
      indexes: [
        { name: 'by_username', keyPath: 'username', options: { unique: false } },
        { name: 'by_name',     keyPath: 'name',     options: { unique: false } },
        { name: 'by_deleted',  keyPath: 'deleted_at' },
      ],
    },

    /**
     * bolsaForms: bolsa registration form records (تسجيل البوالص).
     *
     * Key fields:
     *   username    : FK → users.username
     *   bolsa_date  : ISO date
     *   agent_id    : FK → agents.id (mandoub)
     *   rows        : Array<{ rowdate, driver, owner_name, carNo, weight,
     *                         weight2, office, loading, direction, type,
     *                         ohda, noloon }>
     *   totals      : { ohda, addition, grand_total } (decimals)
     */
    bolsaForms: {
      name          : 'bolsaForms',
      keyPath       : 'id',
      autoIncrement : false,            // UUID pre-generated by caller
      indexes: [
        { name: 'by_username',   keyPath: 'username',   options: { unique: false } },
        { name: 'by_bolsa_date', keyPath: 'bolsa_date', options: { unique: false } },
        { name: 'by_deleted',    keyPath: 'deleted_at' },
      ],
    },

    /**
     * mainCapitalTreasury: tracks the owner's primary capital entries (completely independent).
     */
    mainCapitalTreasury: {
      name          : 'mainCapitalTreasury',
      keyPath       : 'id',
      autoIncrement : false,            // UUID pre-generated by caller
      indexes: [
        { name: 'by_username', keyPath: 'username',   options: { unique: false } },
        { name: 'by_type',     keyPath: 'type',       options: { unique: false } },
        { name: 'by_deleted',  keyPath: 'deleted_at',  options: { unique: false } },
      ],
    },

  };

  // ─── INTERNAL STATE ──────────────────────────────────────────────────────────

  let _db = null; // IDBDatabase instance
  let _readyPromise = null; // single source of truth for readiness

  // ─── INIT ────────────────────────────────────────────────────────────────────

  /**
   * Open (or upgrade) the IndexedDB database.
   * Must be called once at app startup: await DB.init()
   */
  function init() {
    if (_readyPromise) return _readyPromise;

    _readyPromise = new Promise((resolve, reject) => {
      if (_db) return resolve(_db);

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db     = event.target.result;
        const tx     = event.target.transaction;
        const oldVer = event.oldVersion;

        // ── VERSIONS 1–2 → create any stores that don't exist yet ───────────
        // Covers: initial schema (v1) + vehicleOwners, drivers, bolsaForms (v2).
        // New stores are created with all their indexes in one pass.
        // Existing stores are never touched here — no deletions, no data loss.
        // ─────────────────────────────────────────────────────────────────────
        if (oldVer < 2) {
          Object.values(STORES).forEach((storeDef) => {
            if (db.objectStoreNames.contains(storeDef.name)) return;
            const store = db.createObjectStore(storeDef.name, {
              keyPath       : storeDef.keyPath,
              autoIncrement : storeDef.autoIncrement,
            });
            (storeDef.indexes || []).forEach(({ name, keyPath, options }) => {
              store.createIndex(name, keyPath, options || {});
            });
          });
        }

        // ── VERSION 3 → any stores still missing (safe for v1 → v3 jumps) ───
        if (oldVer < 3) {
          Object.values(STORES).forEach((storeDef) => {
            if (db.objectStoreNames.contains(storeDef.name)) return;
            const store = db.createObjectStore(storeDef.name, {
              keyPath       : storeDef.keyPath,
              autoIncrement : storeDef.autoIncrement,
            });
            (storeDef.indexes || []).forEach(({ name, keyPath, options }) => {
              store.createIndex(name, keyPath, options || {});
            });
          });
        }

        // ── VERSION 4 → add by_number index to receipts ─────────────────────
        // Uses the upgrade transaction's objectStore handle (the only correct
        // way to mutate indexes on an existing store).
        // Guarded by indexNames.contains so re-running is always safe.
        // ─────────────────────────────────────────────────────────────────────
        if (oldVer < 4) {
  const receiptsStore = tx.objectStore('receipts');
  if (!receiptsStore.indexNames.contains('by_number')) {
    receiptsStore.createIndex('by_number', 'receipt_number', { unique: true });
  }
}

        // ── VERSION 5 → add counters store for SQL-sequence style numbers ───
        if (oldVer < 5) {
          const counterDef = STORES.counters;
          if (!db.objectStoreNames.contains(counterDef.name)) {
            const store = db.createObjectStore(counterDef.name, {
              keyPath       : counterDef.keyPath,
              autoIncrement : counterDef.autoIncrement,
            });
            (counterDef.indexes || []).forEach(({ name, keyPath, options }) => {
              store.createIndex(name, keyPath, options || {});
            });
          }
        }

        // ── VERSION 6 → add mainCapitalTreasury store ───
        if (oldVer < 6) {
          const capitalDef = STORES.mainCapitalTreasury;
          if (!db.objectStoreNames.contains(capitalDef.name)) {
            const store = db.createObjectStore(capitalDef.name, {
              keyPath       : capitalDef.keyPath,
              autoIncrement : capitalDef.autoIncrement,
            });
            (capitalDef.indexes || []).forEach(({ name, keyPath, options }) => {
              store.createIndex(name, keyPath, options || {});
            });
          }
        }

        // ── VERSION 8 → recreate bolsa stores removed by a reverted change ──
        // An earlier build (v7, since reverted) deleted the bolsa and
        // bolsaForms stores. Databases that already upgraded to v7 are
        // missing them — and sit ABOVE this app's previous version (6),
        // which IndexedDB would reject — so the version moves past 7 and
        // this step recreates any of the two stores that are missing.
        // Stores that still exist are left untouched (no data loss).
        if (oldVer < 8) {
          [STORES.bolsa, STORES.bolsaForms].forEach((storeDef) => {
            if (storeDef && !db.objectStoreNames.contains(storeDef.name)) {
              const store = db.createObjectStore(storeDef.name, {
                keyPath       : storeDef.keyPath,
                autoIncrement : storeDef.autoIncrement,
              });
              (storeDef.indexes || []).forEach(({ name, keyPath, options }) => {
                store.createIndex(name, keyPath, options || {});
              });
            }
          });
        }
      };

      request.onsuccess = (event) => {
        _db = event.target.result;

        _db.onversionchange = () => {
          _db.close();
          _db = null;
          console.warn('[DB] Database version changed — connection closed.');
        };

        resolve(_db);
      };

      request.onerror   = () => {
        _readyPromise = null;
        reject(_wrap_error('init', request.error));
      };
      request.onblocked = () => {
        _readyPromise = null;
        reject(new Error('[DB] Open blocked by another tab.'));
      };
    });

    return _readyPromise;
  }

  // ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

  async function _ensure_ready() {
    if (!_readyPromise) {
      await init();
      return;
    }
    await _readyPromise;
  }

  function _assert_ready() {
    if (!_db) throw new Error('[DB] Not initialised after init().');
  }

  function _wrap_error(context, err) {
    return new Error(`[DB:${context}] ${err?.message || err}`);
  }

  function _debug_enabled() {
    return typeof window !== 'undefined' && window.__DB_DEBUG__ === true;
  }

  function _debug_log(message, data) {
    if (!_debug_enabled()) return;
    if (data !== undefined) {
      console.info(`[DB:debug] ${message}`, data);
      return;
    }
    console.info(`[DB:debug] ${message}`);
  }

  function _assertNoPredicate(input) {
    if (typeof input === 'function') {
      throw new Error('[DB] predicate queries are not allowed');
    }
  }

  /**
   * Returns current timestamp (ms since epoch).
   */
  function _now() {
    return Date.now();
  }

  /**
   * Inject required meta fields on every record.
   * username MUST be provided via meta parameter — no globals.
   */
  function _inject_meta(payload, isNew, meta) {
    if (!meta || !meta.username) {
      throw new Error('[DB] meta.username is required');
    }
    if ('username' in payload && payload.username !== meta.username) {
      throw new Error('[DB] username must match session user');
    }
    if ('created_by' in payload || 'updated_by' in payload) {
      throw new Error('[DB] payload must not contain audit fields');
    }

    const now = Date.now();
    const next = { ...payload };

    next.updated_at = now;
    next.updated_by = meta.username;

    if (isNew) {
      next.created_at = now;
      next.created_by = meta.username;
      next.deleted_at = null;
    }

    return next;
  }

  /**
   * Open a single-store IDB transaction and return { tx, store }.
   * mode: 'readonly' | 'readwrite'
   */
  function _open_tx(storeName, mode = 'readonly') {
    _assert_ready();
    if (!_db.objectStoreNames.contains(storeName)) {
      throw new Error(`[DB] Invalid store: ${storeName}`);
    }
    const tx    = _db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { tx, store };
  }

  /**
   * Promisify a single IDBRequest.
   */
  function _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror   = () => reject(request.error);
    });
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * DB.getAll(store, filters?)
   * Returns all non-deleted records.
   * filters: optional plain object { field: value } for simple equality checks.
   */
  async function getAll(storeName, filters = null) {
    await _ensure_ready();
    _assert_ready();
    const { store } = _open_tx(storeName, 'readonly');
    const all = await _req(store.getAll());

    // Always exclude soft-deleted records
    let result = all.filter((r) => r.deleted_at === null);

    if (filters) {
      result = result.filter((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v)
      );
    }

    return result;
  }

  /**
   * DB.getById(store, id)
   * Returns one record or null. Returns null if soft-deleted.
   */
  async function getById(storeName, id) {
    await _ensure_ready();
    _assert_ready();
    const { store } = _open_tx(storeName, 'readonly');
    const record = await _req(store.get(id));

    if (!record || record.deleted_at !== null) return null;
    return record;
  }

  /**
   * DB.getByIndex(store, indexName, value)
   * Returns all non-deleted records matching a specific index value.
   */
  async function getByIndex(storeName, indexName, value) {
    await _ensure_ready();
    _assert_ready();

    const { store } = _open_tx(storeName, 'readonly');
    const index      = store.index(indexName);   // throws NotFoundError if schema is wrong — correct behaviour

    const queryValue = Array.isArray(value) ? IDBKeyRange.only(value) : value;
    const all        = await _req(index.getAll(queryValue));

    return all.filter((r) => r.deleted_at === null);
  }

  /**
   * DB.findByFields(store, filters, options?)
   * Structured equality filtering without predicate functions.
   * options.includeDeleted: include soft-deleted records (default false)
   */
  async function findByFields(storeName, filters = {}, options = {}) {
    if (typeof arguments[1] === 'function') {
      throw new Error('[DB] predicate functions are forbidden');
    }
    _assertNoPredicate(filters);
    await _ensure_ready();
    _assert_ready();
    const { store } = _open_tx(storeName, 'readonly');
    const all = await _req(store.getAll());
    const includeDeleted = options?.includeDeleted === true;

    return all.filter((record) => {
      if (!includeDeleted && record?.deleted_at !== null) return false;
      return Object.entries(filters || {}).every(([key, value]) => record?.[key] === value);
    });
  }

  /**
   * DB.add(store, payload, meta)
   * Inserts a new record. Injects meta fields automatically.
   * Returns the saved record (including auto-generated id).
   * meta: { username } — REQUIRED.
   */
  async function add(storeName, payload, meta) {
    if (!meta?.username) throw new Error('[DB.add] username required');
    await _ensure_ready();
    _assert_ready();
    const record    = _inject_meta(payload, true, meta);
    const { store } = _open_tx(storeName, 'readwrite');
    const id        = await _req(store.add(record));

    return { ...record, id };
  }

  /**
   * DB.update(store, id, patch)
   * Merges patch into the existing record. Updates updated_at.
   * Returns the updated record.
   * ⚠️ For financial records, call through FinancialService (reverse + reapply).
   *
   * FIX: get() + put() share ONE readwrite transaction — no race condition window.
   */
  async function update(storeName, id, patch, meta) {
    if (!meta?.username) throw new Error('[DB.update] username required');
    await _ensure_ready();
    _assert_ready();
    return new Promise((resolve, reject) => {
      const tx    = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      const getReq = store.get(id);

      getReq.onsuccess = () => {
        const existing = getReq.result;

        if (!existing) {
          tx.abort();
          return reject(_wrap_error('update', `Record ${id} not found in ${storeName}`));
        }
        if (existing.deleted_at !== null) {
          tx.abort();
          return reject(_wrap_error('update', `Record ${id} is soft-deleted`));
        }

        if (patch && ('created_by' in patch || 'updated_by' in patch)) {
          tx.abort();
          return reject(_wrap_error('update', '[DB] payload must not contain audit fields'));
        }

        const merged = { ...existing, ...patch };
        const { created_by, updated_by, ...clean } = merged;
        const updated = _inject_meta(clean, false, meta);
        if (created_by !== undefined) updated.created_by = created_by;
        const putReq  = store.put(updated);

        putReq.onsuccess = () => resolve(updated);
        putReq.onerror   = () => { tx.abort(); reject(_wrap_error('update:put', putReq.error)); };
      };

      getReq.onerror = () => reject(_wrap_error('update:get', getReq.error));
      tx.onerror     = () => reject(_wrap_error('update:tx',  tx.error));
    });
  }

  /**
   * DB.delete(store, id)
   * Soft-delete: sets deleted_at to current timestamp.
   * Returns the deleted record snapshot.
   * ⚠️ For financial records, call through FinancialService (reverse + reapply).
   *
   * FIX: get() + put() share ONE readwrite transaction — no race condition window.
   */
  async function softDelete(storeName, id, meta) {
    if (!meta?.username) throw new Error('[DB.delete] username required');
    await _ensure_ready();
    _assert_ready();
    return new Promise((resolve, reject) => {
      const tx    = _db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      const getReq = store.get(id);

      getReq.onsuccess = () => {
        const existing = getReq.result;

        if (!existing) {
          tx.abort();
          return reject(_wrap_error('delete', `Record ${id} not found in ${storeName}`));
        }
        if (existing.deleted_at !== null) {
          tx.abort();
          return reject(_wrap_error('delete', `Record ${id} already deleted`));
        }

        const now = _now();
        const deleted = {
          ...existing,
          updated_at: now,
          updated_by: meta.username,
          deleted_at: now,
        };

        const putReq = store.put(deleted);

        putReq.onsuccess = () => resolve(deleted);
        putReq.onerror   = () => { tx.abort(); reject(_wrap_error('delete:put', putReq.error)); };
      };

      getReq.onerror = () => reject(_wrap_error('delete:get', getReq.error));
      tx.onerror     = () => reject(_wrap_error('delete:tx',  tx.error));
    });
  }

  /**
   * DB.hardDelete(store, id)
   * Permanent removal. Use only for cleanup / admin ops.
   */
  async function hardDelete(storeName, id) {
    await _ensure_ready();
    _assert_ready();
    const { store } = _open_tx(storeName, 'readwrite');
    await _req(store.delete(id));
  }

  /**
   * Callback transaction API.
   * Keep reads and writes inside this callback so Phase 2 can map it directly
   * to one SQL transaction with locked reads.
   */
  async function transactionCallback(callback, meta) {
    if (!meta?.username) throw new Error('[DB.transaction] username required');
    if (typeof callback !== 'function') {
      throw new Error('[DB.transaction] callback must be a function');
    }

    await _ensure_ready();
    _assert_ready();

    const explicitStores = Array.isArray(meta.stores) && meta.stores.length > 0
      ? meta.stores
      : Object.keys(STORES);
    const storeNames = [...new Set(explicitStores)];

    for (const name of storeNames) {
      if (!_db.objectStoreNames.contains(name)) {
        throw new Error(`[DB] Invalid store: ${name}`);
      }
    }

    return new Promise((resolve, reject) => {
      const tx = _db.transaction(storeNames, 'readwrite');
      let callbackResult;
      let done = false;

      function finishReject(err) {
        if (done) return;
        done = true;
        reject(err);
      }

      function txStore(storeName) {
        if (!storeNames.includes(storeName)) {
          throw new Error(`[DB.transaction] Store "${storeName}" was not opened in this transaction.`);
        }
        return tx.objectStore(storeName);
      }

      function txReq(request, context) {
        return new Promise((resolveReq, rejectReq) => {
          request.onsuccess = () => resolveReq(request.result);
          request.onerror = () => {
            const err = _wrap_error(context, request.error);
            try { tx.abort(); } catch (_) {}
            rejectReq(err);
          };
        });
      }

      const txApi = Object.freeze({
        async getAll(storeName, filters = null, options = {}) {
          const all = await txReq(txStore(storeName).getAll(), `tx:getAll:${storeName}`);
          const includeDeleted = options?.includeDeleted === true;
          let result = includeDeleted ? all : all.filter((r) => r?.deleted_at === null);
          if (filters) {
            _assertNoPredicate(filters);
            result = result.filter((r) =>
              Object.entries(filters).every(([k, v]) => r?.[k] === v)
            );
          }
          return result;
        },

        async getById(storeName, id, options = {}) {
          const record = await txReq(txStore(storeName).get(id), `tx:getById:${storeName}`);
          if (!record) return null;
          if (options?.includeDeleted !== true && record.deleted_at !== null) return null;
          return record;
        },

        async getByIndex(storeName, indexName, value, options = {}) {
          const index = txStore(storeName).index(indexName);
          const queryValue = Array.isArray(value) ? IDBKeyRange.only(value) : value;
          const all = await txReq(index.getAll(queryValue), `tx:getByIndex:${storeName}.${indexName}`);
          return options?.includeDeleted === true
            ? all
            : all.filter((r) => r?.deleted_at === null);
        },

        async findByFields(storeName, filters = {}, options = {}) {
          if (typeof filters === 'function') {
            throw new Error('[DB] predicate functions are forbidden');
          }
          _assertNoPredicate(filters);
          const all = await txReq(txStore(storeName).getAll(), `tx:findByFields:${storeName}`);
          const includeDeleted = options?.includeDeleted === true;
          return all.filter((record) => {
            if (!includeDeleted && record?.deleted_at !== null) return false;
            return Object.entries(filters || {}).every(([key, value]) => record?.[key] === value);
          });
        },

        async add(storeName, payload) {
          const staged = _inject_meta(payload, true, meta);
          const id = await txReq(txStore(storeName).add(staged), `tx:add:${storeName}`);
          return { ...staged, id };
        },

        async update(storeName, id, patch, options = {}) {
          const store = txStore(storeName);
          const existing = await txReq(store.get(id), `tx:update:get:${storeName}`);
          if (!existing) {
            throw _wrap_error('tx:update', `Record ${id} not found in ${storeName}`);
          }
          if (options?.includeDeleted !== true && existing.deleted_at !== null) {
            throw _wrap_error('tx:update', `Record ${id} is soft-deleted`);
          }
          if (patch && ('created_by' in patch || 'updated_by' in patch)) {
            throw _wrap_error('tx:update', '[DB] payload must not contain audit fields');
          }

          const merged = { ...existing, ...patch };
          const { created_by, updated_by, ...clean } = merged;
          const updated = _inject_meta(clean, false, meta);
          if (created_by !== undefined) updated.created_by = created_by;
          await txReq(store.put(updated), `tx:update:put:${storeName}`);
          return updated;
        },

        async delete(storeName, id, patch = null) {
          const store = txStore(storeName);
          const existing = await txReq(store.get(id), `tx:delete:get:${storeName}`);
          if (!existing) {
            throw _wrap_error('tx:delete', `Record ${id} not found in ${storeName}`);
          }
          if (existing.deleted_at !== null) {
            throw _wrap_error('tx:delete', `Record ${id} already deleted`);
          }
          const now = _now();
          const deleted = {
            ...existing,
            ...(patch || {}),
            updated_at: now,
            updated_by: meta.username,
            deleted_at: now,
          };
          await txReq(store.put(deleted), `tx:delete:put:${storeName}`);
          return deleted;
        },

        async hardDelete(storeName, id) {
          await txReq(txStore(storeName).delete(id), `tx:hardDelete:${storeName}`);
          return { id, hardDeleted: true };
        },

        async runOps(ops = []) {
          const normalizedOps = ops.map((o) => ({ ...o, op: o.op || o.type }));
          const results = [];
          for (const op of normalizedOps) {
            switch (op.op) {
              case 'add':
                results.push(await this.add(op.store, op.payload));
                break;
              case 'update':
                results.push(await this.update(op.store, op.id, op.patch));
                break;
              case 'delete':
                results.push(await this.delete(op.store, op.id, op.patch || null));
                break;
              case 'hardDelete':
                results.push(await this.hardDelete(op.store, op.id));
                break;
              default:
                throw _wrap_error('tx:runOps', `Unknown op: ${op.op}`);
            }
          }
          return results;
        },
      });

      tx.onerror = () => finishReject(_wrap_error('transaction', tx.error));
      tx.onabort = () => finishReject(_wrap_error('transaction', 'Transaction aborted'));
      tx.oncomplete = () => {
        if (done) return;
        done = true;
        resolve(callbackResult);
      };

      Promise.resolve()
        .then(() => callback(txApi))
        .then((result) => {
          callbackResult = result;
        })
        .catch((err) => {
          try { tx.abort(); } catch (_) {}
          finishReject(err);
        });
    });
  }

  /**
   * DB.transaction(ops)
   * ─────────────────────────────────────────────────────────────────────────────
   * Executes multiple operations atomically across one or more stores.
   *
   * ops: Array of operation descriptors:
   *   { op: 'add',        store, payload }
   *   { op: 'update',     store, id, patch }
   *   { op: 'delete',     store, id }          ← soft-delete
   *   { op: 'hardDelete', store, id }
   *
   * Returns an array of results in the same order as ops.
   *
   * All ops share a single IDBTransaction across all required stores,
   * so any failure rolls back everything.
   * ─────────────────────────────────────────────────────────────────────────────
   */
  async function transactionBatch(ops, meta) {
    if (!meta?.username) throw new Error('[DB.transaction] username required');
    await _ensure_ready();
    return new Promise((resolve, reject) => {
      _assert_ready();

      if (!ops || ops.length === 0) return resolve([]);

      // Collect unique store names required
      const normalizedOps = ops.map((o) => ({
        ...o,
        op: o.op || o.type,
      }));
      const storeNames = [...new Set(normalizedOps.map((o) => o.store))];

      // Validate all store names exist
      for (const name of storeNames) {
        if (!_db.objectStoreNames.contains(name)) {
          return reject(new Error(`[DB] Invalid store: ${name}`));
        }
      }

      // Open a single multi-store readwrite transaction
      const tx = _db.transaction(storeNames, 'readwrite');

      const results = [];
      let currentOpIndex = 0;

      tx.onerror   = () => reject(_wrap_error('transaction', tx.error));
      tx.onabort   = () => reject(_wrap_error('transaction', 'Transaction aborted'));

      function runNext() {
        if (currentOpIndex >= normalizedOps.length) {
          // All ops scheduled — tx.oncomplete will resolve
          return;
        }

        const op    = normalizedOps[currentOpIndex++];
        const store = tx.objectStore(op.store);

        let request;
        let staged; // record to be stored (before IDB assigns id)

        switch (op.op) {

          case 'add': {
            _debug_log('transaction:add:pre_inject', {
              store: op.store,
              metaUser: meta.username,
              payloadUser: op.payload?.username,
            });
            staged  = _inject_meta(op.payload, true, meta);
            request = store.add(staged);
            request.onsuccess = () => {
              results.push({ ...staged, id: request.result });
              runNext();
            };
            request.onerror = () => {
              tx.abort();
              reject(_wrap_error('transaction:add', request.error));
            };
            break;
          }

          case 'update': {
            const getReq = store.get(op.id);
            getReq.onsuccess = () => {
              const existing = getReq.result;
              if (!existing) {
                tx.abort();
                return reject(_wrap_error('transaction:update', `Record ${op.id} not found in ${op.store}`));
              }
              _debug_log('transaction:update:existing', {
                store: op.store,
                id: op.id,
                metaUser: meta.username,
                existingUser: existing?.username,
                existingCreatedBy: existing?.created_by,
                patchUser: op.patch?.username,
              });
              if (op.patch && ('created_by' in op.patch || 'updated_by' in op.patch)) {
                tx.abort();
                return reject(_wrap_error('transaction:update', '[DB] payload must not contain audit fields'));
              }

              const merged = { ...existing, ...op.patch };
              _debug_log('transaction:update:merged', {
                store: op.store,
                id: op.id,
                metaUser: meta.username,
                mergedUser: merged?.username,
              });
              const { created_by, updated_by, ...clean } = merged;
              _debug_log('transaction:update:pre_inject', {
                store: op.store,
                id: op.id,
                metaUser: meta.username,
                cleanUser: clean?.username,
              });
              const updated = _inject_meta(clean, false, meta);
              _debug_log('transaction:update:post_inject', {
                store: op.store,
                id: op.id,
                metaUser: meta.username,
                updatedUser: updated?.username,
              });
              if (created_by !== undefined) updated.created_by = created_by;
              const putReq  = store.put(updated);
              putReq.onsuccess = () => {
                results.push(updated);
                runNext();
              };
              putReq.onerror = () => {
                tx.abort();
                reject(_wrap_error('transaction:update', putReq.error));
              };
            };
            getReq.onerror = () => {
              tx.abort();
              reject(_wrap_error('transaction:update:get', getReq.error));
            };
            break;
          }

          case 'delete': {
            // soft-delete
            const getReq = store.get(op.id);
            getReq.onsuccess = () => {
              const existing = getReq.result;
              if (!existing) {
                tx.abort();
                return reject(_wrap_error('transaction:delete', `Record ${op.id} not found in ${op.store}`));
              }
              const now      = _now();
              const deleted  = {
                ...existing,
                ...(op.patch || {}),
                updated_at: now,
                updated_by: meta.username,
                deleted_at: now,
              };
              const putReq   = store.put(deleted);
              putReq.onsuccess = () => {
                results.push(deleted);
                runNext();
              };
              putReq.onerror = () => {
                tx.abort();
                reject(_wrap_error('transaction:delete', putReq.error));
              };
            };
            getReq.onerror = () => {
              tx.abort();
              reject(_wrap_error('transaction:delete:get', getReq.error));
            };
            break;
          }

          case 'hardDelete': {
            const delReq = store.delete(op.id);
            delReq.onsuccess = () => {
              results.push({ id: op.id, hardDeleted: true });
              runNext();
            };
            delReq.onerror = () => {
              tx.abort();
              reject(_wrap_error('transaction:hardDelete', delReq.error));
            };
            break;
          }

          default:
            tx.abort();
            reject(_wrap_error('transaction', `Unknown op: ${op.op}`));
        }
      }

      tx.oncomplete = () => resolve(results);

      // Kick off
      runNext();
    });
  }

  async function transaction(opsOrCallback, meta) {
    if (typeof opsOrCallback === 'function') {
      return transactionCallback(opsOrCallback, meta);
    }
    return transactionBatch(opsOrCallback, meta);
  }

  // ─── DIAGNOSTICS (dev only) ──────────────────────────────────────────────────

  /**
   * DB.dump(store?) — returns ALL records including soft-deleted.
   * For debugging only. Strip before production.
   */
  async function dump(storeName) {
    if (location.hostname !== 'localhost') {
      throw new Error('Forbidden in production');
    }
    await _ensure_ready();
    _assert_ready();
    const names = storeName ? [storeName] : Object.keys(STORES);
    const result = {};

    for (const name of names) {
      const { store } = _open_tx(name, 'readonly');
      result[name] = await _req(store.getAll());
    }

    return storeName ? result[storeName] : result;
  }

  /**
   * DB.nuke() — destroys entire DB. DANGER. Dev only.
   */
  async function nuke() {
    if (location.hostname !== 'localhost') {
      throw new Error('Forbidden in production');
    }
    await _ensure_ready();
    _readyPromise = null;
    if (_db) { _db.close(); _db = null; }
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => { console.warn('[DB] Database nuked.'); resolve(); };
      req.onerror   = () => reject(req.error);
    });
  }

  // ─── EXPORT ──────────────────────────────────────────────────────────────────

  return Object.freeze({
    // Lifecycle
    init,

    // CRUD — these names NEVER change (Phase 2 replaces internals only)
    getAll,
    getById,
    getByIndex,
    findByFields,
    add,
    update,
    delete: softDelete,   // alias: DB.delete()
    hardDelete,
    transaction,

    // Dev tools
    dump,
    nuke,

    // Schema reference (read-only)
    STORES,

    // Internal DB instance accessor — used by backup system only.
    // NOT part of the public CRUD API. Does NOT change in MySQL migration.
    get _db() { return _db; },
  });

})();
export { DB };
