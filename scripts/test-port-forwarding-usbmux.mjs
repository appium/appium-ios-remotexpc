#!/usr/bin/env node

import { logger } from '@appium/support';
import { Command } from 'commander';
import { createConnection } from 'node:net';

import {
  DevicePortForwarder,
  connectViaUsbmux,
  createUsbmux,
} from '../build/src/index.js';

const log = logger.getLogger('TestPortForwardingUsbmux');

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid port: ${value}. Expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

async function canConnectLocalPort(host, port, timeoutMs = 2000) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const cleanup = () => {
      socket.removeAllListeners();
      socket.setTimeout(0);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      cleanup();
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      cleanup();
      socket.destroy();
      resolve(false);
    });
  });
}

async function resolveUdid(requestedUdid) {
  const usbmux = await createUsbmux();
  try {
    const devices = await usbmux.listDevices();
    if (!devices.length) {
      throw new Error('No devices found via usbmux.');
    }
    if (requestedUdid) {
      const device = devices.find((d) => d.Properties.SerialNumber === requestedUdid);
      if (!device) {
        throw new Error(`Requested UDID not found: ${requestedUdid}`);
      }
      return requestedUdid;
    }
    return devices[0].Properties.SerialNumber;
  } finally {
    await usbmux.close();
  }
}

async function main() {
  const program = new Command();
  program
    .name('test-port-forwarding-usbmux')
    .description('Test local port forwarding to a usbmux device port')
    .option('--udid <udid>', 'Target device UDID (defaults to first usbmux device)')
    .requiredOption(
      '--device-port <port>',
      'Target port on device (for example 8100)',
      parsePort,
    )
    .option(
      '--local-port <port>',
      'Local forwarded port to bind',
      parsePort,
      18100,
    )
    .option(
      '--host <host>',
      'Local host to bind',
      '127.0.0.1',
    );

  program.parse(process.argv);
  const options = program.opts();

  const udid = await resolveUdid(options.udid);
  const devicePort = options.devicePort;
  const localPort = options.localPort;
  const host = options.host;

  log.info(`Using UDID: ${udid}`);
  log.info(`Forwarding ${host}:${localPort} -> device:${devicePort}`);

  const forwarder = new DevicePortForwarder(localPort, devicePort, {
    host,
    primaryConnector: () => connectViaUsbmux(udid, devicePort),
  });

  forwarder.on('started', () => log.info('Forwarder started'));
  forwarder.on('clientConnected', () => log.info('Client connected'));
  forwarder.on('upstreamConnected', () => log.info('Upstream connected'));
  forwarder.on('upstreamConnectError', (err) =>
    log.warn(`Upstream connect failed: ${String(err)}`),
  );
  forwarder.on('error', (err) => log.warn(`Forwarder error: ${String(err)}`));
  forwarder.on('stopped', () => log.info('Forwarder stopped'));

  try {
    await forwarder.start();
    const open = await canConnectLocalPort(host, localPort);
    if (!open) {
      throw new Error(
        `Port probe failed: could not connect to local forwarded port ${host}:${localPort}`,
      );
    }
    log.info(`Port probe passed: ${host}:${localPort} is reachable`);
  } finally {
    await forwarder.stop();
  }
}

await main();
