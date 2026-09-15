import net from 'node:net';

const TUNNEL_REGISTRY_HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 20;
const MAX_TCP_PORT = 65535;

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, TUNNEL_REGISTRY_HOST, () => probe.close(() => resolve(true)));
  });
}

/**
 * Ports from `preferredPort` upward, bounded by the attempt limit and the TCP range.
 * @param {number} preferredPort
 * @returns {number[]}
 */
function candidatePorts(preferredPort) {
  const lastPort = Math.min(preferredPort + MAX_PORT_ATTEMPTS - 1, MAX_TCP_PORT);
  return Array.from({length: lastPort - preferredPort + 1}, (_, offset) => preferredPort + offset);
}

/**
 * Returns `preferredPort` if free, else the next free port above it.
 * @param {number} preferredPort
 * @param {{warn: (message: string) => void}} log
 * @returns {Promise<number>}
 */
export async function resolveAvailableRegistryPort(preferredPort, log) {
  const candidates = candidatePorts(preferredPort);
  for (const port of candidates) {
    if (!(await isPortAvailable(port))) {
      continue;
    }
    if (port !== preferredPort) {
      log.warn(`Tunnel registry port ${preferredPort} is in use; using ${port} instead`);
    }
    return port;
  }
  throw new Error(`No free tunnel registry port in range ${candidates.at(0)}-${candidates.at(-1)}`);
}
