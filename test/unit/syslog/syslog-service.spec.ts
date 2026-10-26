import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {ServiceConnection} from '../../../src/service-connection.js';
import {SyslogLogLevel} from '../../../src/services/ios/syslog-service/syslog-entry-parser.js';
import {mockImport} from '../../helpers/mock-module.js';

function framePlist(data: PlistDictionary): Buffer {
  const xml = createPlist(data);
  const buf = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

function createSyslogEntryBuffer(message: string): Buffer {
  const filename = '/usr/bin/myapp\0';
  const imageName = 'MyApp\0';
  const messageBytes = `${message}\0`;
  const headerSize = 129;
  const totalSize =
    headerSize + Buffer.byteLength(filename) + Buffer.byteLength(imageName) + Buffer.byteLength(messageBytes);
  const buffer = Buffer.alloc(totalSize);
  buffer.fill(0, 0, headerSize);
  buffer.writeUInt32LE(1234, 9);
  buffer.writeUInt32LE(1700000000, 55);
  buffer.writeUInt32LE(500000, 63);
  buffer.writeUInt8(SyslogLogLevel.Info, 68);
  buffer.writeUInt16LE(Buffer.byteLength(imageName), 107);
  buffer.writeUInt16LE(Buffer.byteLength(messageBytes), 109);
  let offset = headerSize;
  buffer.write(filename, offset);
  offset += Buffer.byteLength(filename);
  buffer.write(imageName, offset);
  offset += Buffer.byteLength(imageName);
  buffer.write(messageBytes, offset);
  return buffer;
}

function frameSyslogEntry(message: string): Buffer {
  const entry = createSyslogEntryBuffer(message);
  const header = Buffer.alloc(5);
  header.writeUInt8(0x02, 0);
  header.writeUInt32LE(entry.length, 1);
  return Buffer.concat([header, entry]);
}

describe('SyslogService binary mode', function () {
  it('reads framed syslog entries from the service socket after StartActivity', async function (t) {
    const socket = new PassThrough();
    const fakeConnection = {
      sendPlistRequest: async () => ({Status: 'RequestSuccessful'}),
      getSocket: () => socket,
      detachSocket: () => socket,
      close: () => {
        socket.destroy();
      },
    };

    const {default: SyslogService} = await mockImport(
      t,
      '../../../src/services/ios/syslog-service/index.js',
      import.meta.url,
      {
        '../../../src/services/ios/base-service.js': {
          BaseService: class {
            constructor(udid: string) {
              void udid;
            }
            async startLockdownService() {
              return fakeConnection;
            }
          },
        },
      },
    );

    const service = new SyslogService('test-udid');
    const messages: string[] = [];
    service.on('message', (msg: string) => messages.push(msg));

    const startPromise = service.start({serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'}, {pid: -1});

    await startPromise;

    socket.write(frameSyslogEntry('hello from socket'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    await service.stop();

    assert.strictEqual(
      messages.some((m) => m.includes('hello from socket')),
      true,
    );
  });

  it('preserves syslog frames coalesced in the same TCP chunk as the StartActivity plist reply', async function (t) {
    const socket = new PassThrough();
    const connection = new ServiceConnection(socket as any);

    const {default: SyslogService} = await mockImport(
      t,
      '../../../src/services/ios/syslog-service/index.js',
      import.meta.url,
      {
        '../../../src/services/ios/base-service.js': {
          BaseService: class {
            constructor(udid: string) {
              void udid;
            }
            async startLockdownService() {
              return connection;
            }
          },
        },
      },
    );

    const service = new SyslogService('test-udid');
    const messages: string[] = [];
    service.on('message', (msg: string) => messages.push(msg));

    const startPromise = service.start({serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'}, {pid: -1});

    setImmediate(() => {
      socket.write(
        Buffer.concat([framePlist({Status: 'RequestSuccessful'}), frameSyslogEntry('coalesced binary entry')]),
      );
    });

    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.stop();

    assert.strictEqual(
      messages.some((m) => m.includes('coalesced binary entry')),
      true,
    );
  });

  it('preserves text-mode syslog lines buffered in the plist splitter during RSDCheckin', async function (t) {
    const socket = new PassThrough();
    const connection = new ServiceConnection(socket as any);

    const {default: SyslogService} = await mockImport(
      t,
      '../../../src/services/ios/syslog-service/index.js',
      import.meta.url,
      {
        '../../../src/services/ios/base-service.js': {
          BaseService: class {
            constructor(udid: string) {
              void udid;
            }
            async startLockdownService() {
              socket.write(
                Buffer.concat([
                  framePlist({Request: 'RSDCheckin'}),
                  Buffer.from('Oct 26 12:00:00 iPhone kernel[0]: coalesced text line\n\0', 'utf8'),
                ]),
              );
              await connection.receive(1000);
              return connection;
            }
          },
        },
      },
    );

    const service = new SyslogService('test-udid');
    const messages: string[] = [];
    service.on('message', (msg: string) => messages.push(msg));

    await service.start({serviceName: 'com.apple.syslog_relay.shim.remote', port: '1'}, {textMode: true});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.stop();

    assert.strictEqual(
      messages.some((m) => m.includes('coalesced text line')),
      true,
    );
  });

  it('closes the connection when StartActivity returns an error status', async function (t) {
    const socket = new PassThrough();
    let closed = false;
    const fakeConnection = {
      sendPlistRequest: async () => ({Status: 'InvalidService'}),
      getSocket: () => socket,
      detachSocket: () => socket,
      close: () => {
        closed = true;
        socket.destroy();
      },
    };

    const {default: SyslogService} = await mockImport(
      t,
      '../../../src/services/ios/syslog-service/index.js',
      import.meta.url,
      {
        '../../../src/services/ios/base-service.js': {
          BaseService: class {
            constructor(udid: string) {
              void udid;
            }
            async startLockdownService() {
              return fakeConnection;
            }
          },
        },
      },
    );

    const service = new SyslogService('test-udid');
    await assert.rejects(
      service.start({serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'}),
      /StartActivity failed/,
    );
    assert.strictEqual(closed, true);
  });
});
