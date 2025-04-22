import type { TunnelConnection } from 'tuntap-bridge';

import SyslogService from '../src/Services/IOS/SyslogService/index.js';
import { startCoreDeviceProxy } from '../src/Services/IOS/TunnelService/index.js';
import { createLockdownServiceByUDID } from '../src/lib/Lockdown/index.js';
import RemoteXpcConnection from '../src/lib/RemoteXPC/remote-xpc-connection.js';
import TunnelManager from '../src/lib/Tunnel/index.js';

async function test() {
  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  console.log('create connection....');
  const { lockdownService, device } = await createLockdownServiceByUDID();
  const { socket } = await startCoreDeviceProxy(
    lockdownService,
    device.DeviceID,
    device.Properties.SerialNumber,
    {},
  );
  try {
    tunnelResult = await tunManager.getTunnel(socket);
    // console.log(tunnelResult)

    // Fix: Check if RsdPort is defined and provide a fallback value if it's undefined
    const rsdPort = tunnelResult.RsdPort ?? 0; // Using nullish coalescing operator

    const remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();
    remoteXPC.listAllServices();
    // console.log(remoteXPC.getServices())
    const service = remoteXPC.findService(
      'com.apple.os_trace_relay.shim.remote',
    );
    // let restart = remoteXPC.findService('com.apple.mobile.diagnostics_relay.shim.remote')

    const syslogService = new SyslogService([tunnelResult.Address, rsdPort]);
    await syslogService.start(service, -1, tunnelResult.tunnelManager);
    // await SyslogService.restart(restart)
    await tunManager.closeTunnel();
  } catch (err) {
    console.error('Failed to establish tunnel:', err);
  }
}

test();
