import { DBProvider } from './dbProvider.js';

export const TreasuryRepository = {
  async getById(id) {
    return DBProvider.get('treasury', id);
  },
  async getAll(username) {
    return DBProvider.getAll('treasury', { username });
  },
  async save(payload, meta) {
    return DBProvider.save('treasury', payload, meta);
  },
  async update(id, patch, meta) {
    return DBProvider.update('treasury', id, patch, meta);
  },
  async delete(id, meta) {
    return DBProvider.delete('treasury', id, meta);
  },
  async getByIndex(indexName, value) {
    return DBProvider.getByIndex('treasury', indexName, value);
  },
  async findByFields(filters, options = {}) {
    return DBProvider.findByFields('treasury', filters, options);
  }
};
