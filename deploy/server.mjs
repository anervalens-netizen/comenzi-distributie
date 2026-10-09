import { captureError, flushErrors } from "./error-reporting.mjs";
import { join } from 'node:path';
import { bindConfig, waitForBindAddress } from './bind-ready.mjs';

try {
  const config = bindConfig();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await waitForBindAddress(config);
  const { startProdServer } = await import('vinext/server/prod-server');
  // If the address disappears after the probe, the actual bind fails nonzero;
  // systemd may retry. No catch-all listener or interface fallback is installed.
  await startProdServer({ port, host: config.host, outDir: join(import.meta.dirname, 'dist') });
} catch (error) {
  captureError(error);
  await flushErrors(2000);
  console.error('[startup]', error.code ?? 'STARTUP_FAILED', error.message);
  process.exit(1);
}
