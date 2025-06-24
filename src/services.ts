import { strongbox } from '@appium/strongbox';
import { TunnelManager } from './lib/tunnel/index.js';
import { TunnelApiClient } from './lib/tunnel/tunnel-api-client.js';
import DiagnosticsService from './services/ios/diagnostic-service/index.js';
import SyslogService from './services/ios/syslog-service/index.js';

async function getTunnelInformation(udid: string) {
  const box = strongbox('appium-xcuitest-driver');
  const item = await box.createItem('tunnelRegistryPort');
  const tunnelRegistryPort = await item.read();
  const tunnelApiClient = new TunnelApiClient(`http://localhost:${tunnelRegistryPort}/remotexpc/tunnels`);
  const tunnelExists = await tunnelApiClient.hasTunnel(udid);
  if (!tunnelExists) {
    throw new Error(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first: npm run test:tunnel-creation`,
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

async function startService(host: string, port: number) {
  return await TunnelManager.createRemoteXPCConnection(host, port);
}

async function startDiagnosticsService(udid: string) {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const diagnosticsService = remoteXPC.findService(
    DiagnosticsService.RSD_SERVICE_NAME,
  );
  return new DiagnosticsService([
    tunnelConnection.host,
    parseInt(diagnosticsService.port, 10),
  ]);
}

async function startSyslogService(udid: string) {
  const { tunnelConnection } = await createRemoteXPCConnection(udid);
  return new SyslogService([tunnelConnection.host, tunnelConnection.port]);
}

async function createRemoteXPCConnection(udid: string) {
  const tunnelConnection = await getTunnelInformation(udid);
  const remoteXPC = await startService(
    tunnelConnection.host,
    tunnelConnection.port,
  );
  return { remoteXPC, tunnelConnection };
}

export { startDiagnosticsService, startSyslogService, createRemoteXPCConnection };