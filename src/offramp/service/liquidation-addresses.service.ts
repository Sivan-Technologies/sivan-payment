import { db } from '../../database/json-database.js';
import { notFound } from '../../shared/errors.js';

export async function getLiquidationAddress(id: string) {
  const data = await db.read();
  const record = data.liquidationAddresses.find((la) => la.id === id);
  if (!record) throw notFound('Liquidation address');
  return record;
}

export async function listLiquidationAddresses(userId: string) {
  const data = await db.read();
  return data.liquidationAddresses.filter((la) => la.userId === userId);
}
