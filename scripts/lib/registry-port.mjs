import net from 'node:net';

const TUNNEL_REGISTRY_HOST = '127.0.0.1';

/**
 * Binds to `port` (0 = OS-assigned), then releases it and resolves the bound port.
 * @param {number} port
 * @returns {Promise<number>}
 */
function bindFreePort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, TUNNEL_REGISTRY_HOST, () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not resolve a free port')));
        return;
      }
      probe.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

/**
 * Returns `preferredPort` if free, else a free port chosen by the OS.
 * @param {number} preferredPort
 * @param {{warn: (message: string) => void}} log
 * @returns {Promise<number>}
 */
export async function resolveAvailableRegistryPort(preferredPort, log) {
  try {
    return await bindFreePort(preferredPort);
  } catch {
    const port = await bindFreePort(0);
    log.warn(`Tunnel registry port ${preferredPort} is in use; using ${port} instead`);
    return port;
  }
}
