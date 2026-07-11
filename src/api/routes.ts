import type { FastifyInstance } from 'fastify';
import { usersRoutes } from '../users/users.routes.js';
import { customersRoutes } from '../customers/customers.routes.js';
import { externalAccountsRoutes } from '../offramp/api/external-accounts.routes.js';
import { liquidationAddressesRoutes } from '../offramp/api/liquidation-addresses.routes.js';
import { withdrawalsRoutes } from '../offramp/api/withdrawals.routes.js';
import { webhooksRoutes } from '../webhooks/webhooks.routes.js';
import { feesRoutes } from '../offramp/api/fees.routes.js';
import { metricsRoutes } from '../metrics/metrics.routes.js';
import { providersRoutes } from '../providers/providers.routes.js';
import { adminRoutes } from '../admin/admin.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', service: 'sivan-offramp' }));
  await usersRoutes(app);
  await customersRoutes(app);
  await externalAccountsRoutes(app);
  await liquidationAddressesRoutes(app);
  await withdrawalsRoutes(app);
  await feesRoutes(app);
  await metricsRoutes(app);
  await providersRoutes(app);
  await adminRoutes(app);
  await webhooksRoutes(app);
}
