import { createLockdownServiceByUDID } from '../src/lib/Lockdown/index.js';
import { startCoreDeviceProxy } from '../src/Services/IOS/tunnelService/index.js';
import TunnelManager from '../src/lib/Tunnel/index.js';
import RemoteXPCConnection from '../src/lib/RemoteXPC/RemoteXPCConnection.js';
import type { TunnelConnection } from 'tuntap-bridge';
import DiagnosticsService from '../src/Services/IOS/diagnosticsService/index.js';
import ServiceConnection from '../src/ServiceConnection.js';

async function test() {
  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  console.log('create connection....');
  const udid = '00008120-000648161480201E';
  const { lockdownService, device } = await createLockdownServiceByUDID(udid);
  const { socket } = await startCoreDeviceProxy(
    lockdownService,
    device.DeviceID,
    udid,
    {}
  );
  try {
    tunnelResult = await tunManager.getTunnel(socket);
    // console.log(tunnelResult)

    // Fix: Check if RsdPort is defined and provide a fallback value if it's undefined
    const rsdPort = tunnelResult.RsdPort ?? 0; // Using nullish coalescing operator

    const remoteXPC = new RemoteXPCConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();
    remoteXPC.listAllServices();
    // console.log(remoteXPC.getServices())

    // Find the diagnostics service
    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME
    );

    // Create diagnostics service with the address and port
    const diagService = new DiagnosticsService([
      tunnelResult.Address,
      parseInt(diagnosticsService.port),
    ]);

    // Query some basic device information
    console.log('Querying device information...');
    const powerInfo = await diagService.ioregistry({
      ioClass: 'IOPMPowerSource',
    });
    console.log('Device Information:');
    console.log(powerInfo);
    const wifiInfo = await diagService.ioregistry({
      name: 'AppleBCMWLANSkywalkInterface',
    });
    console.log('wifiInfo Information:');
    console.log(wifiInfo);
    await tunManager.closeTunnel();
  } catch (err) {
    console.error('Failed to establish tunnel:', err);
  }
}

test();
