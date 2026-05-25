/** Host for the local tunnel registry HTTP API and TCP health probe. */
export const TUNNEL_REGISTRY_HOST = '127.0.0.1';

/** Base URL path for the tunnel registry HTTP API. */
export const TUNNEL_REGISTRY_API_BASE_PATH = '/remotexpc/tunnels';

/** Timeout for tunnel registry HTTP lookups (single GET per device). */
export const TUNNEL_REGISTRY_HTTP_TIMEOUT_MS = 500;

/** Timeout for TCP probe that the registry HTTP server is listening. */
export const TUNNEL_REGISTRY_PORT_PROBE_TIMEOUT_MS = 300;
