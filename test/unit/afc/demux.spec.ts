import net from 'node:net';
import {describe, it} from 'node:test';

import {expect} from 'chai';

import {readUInt64LE} from '../../../src/services/ios/afc/codec.js';
import {AFC_HEADER_SIZE} from '../../../src/services/ios/afc/constants.js';
import {AfcPacketDemux} from '../../../src/services/ios/afc/demux.js';
import {AfcError, AfcOpcode} from '../../../src/services/ios/afc/enums.js';

function encodeResponse(op: AfcOpcode, packetNum: bigint, payload: Buffer = Buffer.alloc(0)): Buffer {
  const entireLen = AFC_HEADER_SIZE + payload.length;
  const header = Buffer.alloc(AFC_HEADER_SIZE);
  Buffer.from('CFA6LPAA', 'ascii').copy(header, 0);
  header.writeBigUInt64LE(BigInt(entireLen), 8);
  header.writeBigUInt64LE(BigInt(entireLen), 16);
  header.writeBigUInt64LE(packetNum, 24);
  header.writeBigUInt64LE(BigInt(op), 32);
  return Buffer.concat([header, payload]);
}

describe('AfcPacketDemux', function () {
  it('routes responses to the matching packet_num', async function () {
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const demux = new AfcPacketDemux(getSocket, () => {});

    const responseTask = demux.sendAndWait(AfcOpcode.READ_DIR, Buffer.from('/Downloads\0'));

    const requestHeader = await readExactFromSocket(deviceSide, AFC_HEADER_SIZE);
    const packetNum = readUInt64LE(requestHeader, 24);
    deviceSide.write(encodeResponse(AfcOpcode.DATA, packetNum, Buffer.from('file.txt\0\0')));

    const {status, data} = await responseTask;
    expect(status).to.equal(AfcError.SUCCESS);
    expect(data.toString('utf8')).to.include('file.txt');

    demux.stop();
    server.close();
    client.destroy();
    deviceSide.destroy();
  });

  it('parses STATUS responses', async function () {
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const demux = new AfcPacketDemux(getSocket, () => {});

    const responseTask = demux.sendAndWait(AfcOpcode.GET_FILE_INFO, Buffer.from('/missing\0'));

    const requestHeader = await readExactFromSocket(deviceSide, AFC_HEADER_SIZE);
    const packetNum = readUInt64LE(requestHeader, 24);
    const statusPayload = Buffer.alloc(8);
    statusPayload.writeBigUInt64LE(BigInt(AfcError.OBJECT_NOT_FOUND), 0);
    deviceSide.write(encodeResponse(AfcOpcode.STATUS, packetNum, statusPayload));

    const {status, data} = await responseTask;
    expect(status).to.equal(AfcError.OBJECT_NOT_FOUND);
    expect(data.length).to.equal(0);

    demux.stop();
    server.close();
    client.destroy();
    deviceSide.destroy();
  });

  it('parses FILE_OPEN_RES responses with file handle payload', async function () {
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const demux = new AfcPacketDemux(getSocket, () => {});

    const responseTask = demux.sendAndWait(AfcOpcode.FILE_OPEN, Buffer.from('file\0'));

    const requestHeader = await readExactFromSocket(deviceSide, AFC_HEADER_SIZE);
    const packetNum = readUInt64LE(requestHeader, 24);
    const handlePayload = Buffer.alloc(8);
    handlePayload.writeBigUInt64LE(1n, 0);
    deviceSide.write(encodeResponse(AfcOpcode.FILE_OPEN_RES, packetNum, handlePayload));

    const {status, data} = await responseTask;
    expect(status).to.equal(AfcError.SUCCESS);
    expect(data.readBigUInt64LE(0)).to.equal(1n);

    demux.stop();
    server.close();
    client.destroy();
    deviceSide.destroy();
  });

  it('resets packet_num when the socket is replaced', async function () {
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const demux = new AfcPacketDemux(getSocket, () => {});

    const firstTask = demux.sendAndWait(AfcOpcode.GET_DEVINFO);
    const firstHeader = await readExactFromSocket(deviceSide, AFC_HEADER_SIZE);
    expect(readUInt64LE(firstHeader, 24)).to.equal(0n);
    deviceSide.write(encodeResponse(AfcOpcode.DATA, 0n, Buffer.from('ok\0\0')));
    await firstTask;

    demux.resetForNewSocket();

    const secondTask = demux.sendAndWait(AfcOpcode.GET_DEVINFO);
    const secondHeader = await readExactFromSocket(deviceSide, AFC_HEADER_SIZE);
    expect(readUInt64LE(secondHeader, 24)).to.equal(0n);
    deviceSide.write(encodeResponse(AfcOpcode.DATA, 0n, Buffer.from('ok\0\0')));
    await secondTask;

    demux.stop();
    server.close();
    client.destroy();
    deviceSide.destroy();
  });
});

async function createPairedSockets(): Promise<{
  server: net.Server;
  client: net.Socket;
  deviceSide: net.Socket;
  getSocket: () => Promise<net.Socket>;
}> {
  let deviceSide: net.Socket | null = null;
  const server = net.createServer((socket) => {
    deviceSide = socket;
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }

  const client = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection(address.port, address.address, () => resolve(conn));
    conn.once('error', reject);
  });

  await new Promise<void>((resolve) => {
    const check = () => {
      if (deviceSide) {
        resolve();
        return;
      }
      setImmediate(check);
    };
    check();
  });

  const getSocket = async () => client;

  return {
    server,
    client,
    deviceSide: deviceSide as net.Socket,
    getSocket,
  };
}

function readExactFromSocket(socket: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= n) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.once('error', onError);
  });
}
