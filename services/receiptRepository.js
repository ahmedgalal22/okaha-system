import { DBProvider } from './dbProvider.js';

export const ReceiptRepository = {
  async getById(id) {
    return DBProvider.get('receipts', id);
  },
  async getAll(username) {
    return DBProvider.getAll('receipts', { username });
  },
  async save(payload, meta) {
    return DBProvider.save('receipts', payload, meta);
  },
  async update(id, patch, meta) {
    return DBProvider.update('receipts', id, patch, meta);
  },
  async delete(id, meta) {
    return DBProvider.delete('receipts', id, meta);
  },
  async getByIndex(indexName, value) {
    return DBProvider.getByIndex('receipts', indexName, value);
  },
  async findByFields(filters, options = {}) {
    return DBProvider.findByFields('receipts', filters, options);
  }
};
