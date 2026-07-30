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

let app;
try {
  app = await buildApp();
} catch (error) {
  // Startup misconfiguration (e.g. missing ADMIN_API_KEY in production).
  // Print it plainly so the failure is obvious in Render/CI logs instead of
  // exiting with a bare non-zero code.
  console.error('[startup] Failed to build app:', error instanceof Error ? error.message : error);
  captureError(error as Error, { source: 'build_app' });
  await flushMonitoring();
  process.exit(1);
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  captureError(error, { source: 'server_listen' });
  app.log.error(error);
  await flushMonitoring();
  process.exit(1);
}
