import { strongbox } from '@appium/strongbox';

import { RemoteXpcConnection } from './lib/remote-xpc/remote-xpc-connection.js';
import { TunnelManager } from './lib/tunnel/index.js';
import { TunnelApiClient } from './lib/tunnel/tunnel-api-client.js';
import type {
  DiagnosticsServiceWithConnection,
  SyslogService as SyslogServiceType,
} from './lib/types.js';
import DiagnosticsService from './services/ios/diagnostic-service/index.js';
import SyslogService from './services/ios/syslog-service/index.js';

const APPIUM_XCUITEST_DRIVER_NAME = 'appium-xcuitest-driver';
const TUNNEL_REGISTRY_PORT = 'tunnelRegistryPort';

export async function startDiagnosticsService(
  udid: string,
): Promise<DiagnosticsServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const diagnosticsService = remoteXPC.findService(
    DiagnosticsService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    diagnosticsService: new DiagnosticsService([
      tunnelConnection.host,
      parseInt(diagnosticsService.port, 10),
    ]),
  };
}

export async function startSyslogService(
  udid: string,
): Promise<SyslogServiceType> {
  const { tunnelConnection } = await createRemoteXPCConnection(udid);
  return new SyslogService([tunnelConnection.host, tunnelConnection.port]);
}

export async function createRemoteXPCConnection(udid: string) {
  const tunnelConnection = await getTunnelInformation(udid);
  const remoteXPC = await startService(
    tunnelConnection.host,
    tunnelConnection.port,
  );
  return { remoteXPC, tunnelConnection };
}

// #region Private Functions

async function getTunnelInformation(udid: string) {
  const box = strongbox(APPIUM_XCUITEST_DRIVER_NAME);
  const item = await box.createItem(TUNNEL_REGISTRY_PORT);
  const tunnelRegistryPort = await item.read();
  if (tunnelRegistryPort === undefined) {
    throw new Error(
      'Tunnel registry port not found. Please run the tunnel creation script first: sudo appium driver run xcuitest tunnel-creation',
    );
  }
  const tunnelApiClient = new TunnelApiClient(
    `http://127.0.0.1:${tunnelRegistryPort}/remotexpc/tunnels`,
  );
  const tunnelExists = await tunnelApiClient.hasTunnel(udid);
  if (!tunnelExists) {
    throw new Error(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first: sudo appium driver run xcuitest tunnel-creation`,
    );
  }
  const tunnelConnection = await tunnelApiClient.getTunnelConnection(udid);
  if (!tunnelConnection) {
    throw new Error(
      `Failed to get tunnel connection details for device ${udid}`,
    );
  }
  return tunnelConnection;
}

async function startService(
  host: string,
  port: number,
): Promise<RemoteXpcConnection> {
  return await TunnelManager.createRemoteXPCConnection(host, port);
}

// #endregion
