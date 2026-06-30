import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {expect} from 'chai';
import esmock from 'esmock';

import {SyslogLogLevel} from '../../../src/services/ios/syslog-service/syslog-entry-parser.js';

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
  it('reads framed syslog entries from the service socket after StartActivity', async function () {
    const socket = new PassThrough();
    const fakeConnection = {
      sendPlistRequest: async () => ({Status: 'RequestSuccessful'}),
      getSocket: () => socket,
      close: () => {
        socket.destroy();
      },
    };

    const SyslogService = await esmock('../../../src/services/ios/syslog-service/index.js', {
      '../../../src/services/ios/base-service.js': {
        BaseService: class {
          constructor(_udid: string) {}
          async startLockdownService() {
            return fakeConnection;
          }
        },
      },
    });

    const service = new SyslogService('test-udid');
    const messages: string[] = [];
    service.on('message', (msg: string) => messages.push(msg));

    const startPromise = service.start({serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'}, {pid: -1});

    await startPromise;

    socket.write(frameSyslogEntry('hello from socket'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    await service.stop();

    expect(messages.some((m) => m.includes('hello from socket'))).to.equal(true);
  });
});
