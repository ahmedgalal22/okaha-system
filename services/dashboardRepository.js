import { DBProvider } from './dbProvider.js';

export const DashboardRepository = {
  async getCapitalTransactions(username) {
    const all = await DBProvider.getAll('mainCapitalTreasury', { username });
    return all.filter(t => t && t.deleted_at === null);
  },
  async saveTransaction(payload, meta) {
    return DBProvider.save('mainCapitalTreasury', payload, meta);
  },
  async deleteTransaction(id, meta) {
    return DBProvider.delete('mainCapitalTreasury', id, meta);
  }
};
