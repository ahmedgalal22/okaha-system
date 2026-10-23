/**
 * dbProvider.js — Unified Mid-layer DB Provider
 * Decouples database storage internals from repositories.
 */

import { DB } from '../database.js';

export const DBProvider = {
  async getAll(store, filters = null) {
    return DB.getAll(store, filters);
  },
  async get(store, id) {
    return DB.getById(store, id);
  },
  async save(store, payload, meta) {
    return DB.add(store, payload, meta);
  },
  async update(store, id, patch, meta) {
    return DB.update(store, id, patch, meta);
  },
  async delete(store, id, meta) {
    return DB.delete(store, id, meta);
  },
  async hardDelete(store, id) {
    return DB.hardDelete(store, id);
  },
  async transaction(opsOrCallback, meta) {
    return DB.transaction(opsOrCallback, meta);
  },
  async findByFields(store, filters, options = {}) {
    return DB.findByFields(store, filters, options);
  },
  async getByIndex(store, indexName, value, options = {}) {
    return DB.getByIndex(store, indexName, value, options);
  }
};
