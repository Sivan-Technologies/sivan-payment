import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../auth/auth.routes.js';
import { usersRoutes } from '../users/users.routes.js';
import { customersRoutes } from '../customers/customers.routes.js';
import { externalAccountsRoutes } from '../offramp/api/external-accounts.routes.js';
import { liquidationAddressesRoutes } from '../offramp/api/liquidation-addresses.routes.js';
import { walletRoutes } from '../wallets/wallet.routes.js';
import { withdrawalsRoutes } from '../offramp/api/withdrawals.routes.js';
import { webhooksRoutes } from '../webhooks/webhooks.routes.js';
import { feesRoutes } from '../offramp/api/fees.routes.js';
import { metricsRoutes } from '../metrics/metrics.routes.js';
import { providersRoutes } from '../providers/providers.routes.js';
import { adminRoutes } from '../admin/admin.routes.js';
import { paymentControlsRoutes } from '../controls/payment-controls.routes.js';
import { systemStatusRoutes } from '../system/system-status.routes.js';
import { supportRoutes } from '../support/support.routes.js';
import { db } from '../database/json-database.js';
import { getOperationalHealth } from '../monitoring/operational-health.service.js';
import { onrampOrdersRoutes } from '../onramp/api/onramp-orders.routes.js';
import { identityRoutes } from '../identity/identity.routes.js';
import { virtualAccountsRoutes } from '../virtual-accounts/api/virtual-accounts.routes.js';
import { aceSupportRoutes } from '../ace/api/ace-support.routes.js';
import { ngnRoutes } from '../ngn/api/ngn.routes.js';
import { balanceRoutes } from '../balances/balance.routes.js';
import { supplierRoutes } from '../suppliers/supplier.routes.js';

export async function registerRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok', service: 'sivan-payments' }));
  app.get('/ping', async (_request, reply) => reply.type('text/plain').send('ok'));
  app.get('/health', async () => ({ status: 'ok', service: 'sivan-payments' }));
  app.get('/health/db', async () => ({ status: 'ok', database: db.getPoolStats() }));

  /**
   * Is the money moving?
   *
   * /health says the process is up; this says the product is working. The
   * difference matters because every incident so far has been silent - a
   * stuck webhook, a discarded event, a stale deploy - and /health returned
   * 200 through all of them.
   *
   * Returns 503 when any signal is critical, so a plain uptime monitor
   * (UptimeRobot, Better Stack, an ALB health check) alerts on it without
   * needing to parse the body. 200 with warnings, so a slow review queue
   * does not page anyone at 3am.
   *
   * PUBLIC ON PURPOSE. It exposes counts and states, never user data, and an
   * alerting endpoint behind auth is one credential away from not alerting.
   */
  app.get('/health/operational', async (_request, reply) => {
    const health = await getOperationalHealth();
    return reply.code(health.status === 'critical' ? 503 : 200).send(health);
  });
  await authRoutes(app);
  await usersRoutes(app);
  await identityRoutes(app);
  await virtualAccountsRoutes(app);
  await customersRoutes(app);
  await externalAccountsRoutes(app);
  await liquidationAddressesRoutes(app);
  await walletRoutes(app);
  await withdrawalsRoutes(app);
  await onrampOrdersRoutes(app);
  await feesRoutes(app);
  await metricsRoutes(app);
  await providersRoutes(app);
  await paymentControlsRoutes(app);
  await systemStatusRoutes(app);
  await ngnRoutes(app);
  await balanceRoutes(app);
  await supplierRoutes(app);
  await supportRoutes(app);
  await aceSupportRoutes(app);
  await adminRoutes(app);
  await webhooksRoutes(app);
}
