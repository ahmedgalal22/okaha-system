import { DBProvider } from './dbProvider.js';

export const AuthRepository = {
  async getUser(username) {
    const results = await DBProvider.findByFields('users', { username });
    return results[0] || null;
  },
  async getAllUsers() {
    return DBProvider.getAll('users');
  },
  async saveUser(payload, meta) {
    return DBProvider.save('users', payload, meta);
  }
};
