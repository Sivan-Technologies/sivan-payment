import { buildApp } from './app.js';
import { env } from './config/env.js';
import { captureError, flushMonitoring, initMonitoring } from './monitoring/sentry.js';

initMonitoring();

process.on('unhandledRejection', (error) => {
  captureError(error, { source: 'unhandledRejection' });
});

process.on('uncaughtException', async (error) => {
  captureError(error, { source: 'uncaughtException' });
  await flushMonitoring();
  process.exit(1);
});

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  captureError(error, { source: 'server_listen' });
  app.log.error(error);
  await flushMonitoring();
  process.exit(1);
}
