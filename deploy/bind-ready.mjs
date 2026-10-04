import { createServer, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export function bindConfig(env = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const canonical = isIP(host) === 6 ? new URL(`http://[${host}]`).hostname : host;
  if (!isIP(host) || ['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(canonical)) {
    throw new Error('HOST must be a specific IPv4 or IPv6 address');
  }
  const timeoutMs = Number(env.MOBIUP_BIND_TIMEOUT_MS ?? 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('MOBIUP_BIND_TIMEOUT_MS must be an integer from 1 to 300000');
  }
  return { host, timeoutMs };
}

// Port zero probes address ownership without accepting application traffic or
// occupying the application port. Never substitute a different interface.
function probeAddress(host) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ host, port: 0, ipv6Only: true }, () => probe.close(resolve));
  });
}

export async function waitForBindAddress({ host, timeoutMs }, probe = probeAddress) {
  const deadline = performance.now() + timeoutMs;
  const timeout = () => Object.assign(new Error('Configured HOST did not become available before the bind deadline'), { code: 'BIND_ADDRESS_TIMEOUT' });
  for (;;) {
    try { await probe(host); return; }
    catch (error) {
      if (error.code !== 'EADDRNOTAVAIL') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeout();
      await delay(Math.min(250, remaining));
      if (performance.now() >= deadline) throw timeout();
    }
  }
}
