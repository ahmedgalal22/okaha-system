import { DBProvider } from './dbProvider.js';

export const ClientRepository = {
  async getOwnerById(id) {
    return DBProvider.get('vehicleOwners', id);
  },
  async getAllOwners() {
    return DBProvider.getAll('vehicleOwners');
  },
  async getOwnersForUser(username) {
    return DBProvider.findByFields('vehicleOwners', { username });
  },
  async getAgents(username) {
    return DBProvider.getAll('agents', { username });
  },
  async getVehiclesByPlate(plate) {
    return DBProvider.findByFields('vehicles', { plate });
  },
  async getVehicleById(id) {
    return DBProvider.get('vehicles', id);
  },
  async getDrivers(username) {
    return DBProvider.getByIndex('drivers', 'by_username', username);
  },
  async addDriver(payload, meta) {
    return DBProvider.save('drivers', payload, meta);
  }
};
