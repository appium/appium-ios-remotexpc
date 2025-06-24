import { TunnelManager, tunnelApiClient } from './lib/tunnel/index.js';
import DiagnosticsService from './services/ios/diagnostic-service/index.js';

async function getTunnelInformation(udid: string) {
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
  const tunnelConnection = await getTunnelInformation(udid);
  const remoteXPC = await startService(
    tunnelConnection.host,
    tunnelConnection.port,
  );
  const diagnosticsService = remoteXPC.findService(
    DiagnosticsService.RSD_SERVICE_NAME,
  );
  return new DiagnosticsService([
    tunnelConnection.host,
    parseInt(diagnosticsService.port, 10),
  ]);
}

export { startDiagnosticsService };
