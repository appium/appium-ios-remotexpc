import {once} from 'node:events';
import {type AddressInfo, createConnection, createServer} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {expect} from 'chai';

import {readExact} from '../../../src/services/ios/afc/codec.js';
import {AfcConnectionError} from '../../../src/services/ios/afc/errors.js';

describe('AFC readExact timeout handling', function () {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async function () {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    port = (server.address() as AddressInfo).port;
  });

  after(async function () {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('should destroy the socket and reject subsequent reads after timeout', async function () {
    const client = createConnection({host: '127.0.0.1', port});
    await once(client, 'connect');

    try {
      await readExact(client, 40, 50);
      expect.fail('expected readExact to time out');
    } catch (err) {
      expect(err).to.be.instanceof(AfcConnectionError);
      expect((err as Error).message).to.include('readExact timeout');
    }

    expect(client.destroyed).to.be.true;

    try {
      await readExact(client, 40);
      expect.fail('expected second readExact to fail');
    } catch (err) {
      expect(err).to.be.instanceof(AfcConnectionError);
      expect((err as Error).message).to.match(/closed|destroyed/i);
    }
  });

  it('should not leave stale bytes for the next read after a late response', async function () {
    const client = createConnection({host: '127.0.0.1', port});
    await once(client, 'connect');

    const readPromise = async () => {
      try {
        return await readExact(client, 40, 50);
      } catch (err) {
        return err;
      }
    };

    await new Promise((resolve) => setTimeout(resolve, 60));
    client.write(Buffer.alloc(40, 0xab));

    const firstErr = await readPromise;
    expect(firstErr).to.be.instanceof(AfcConnectionError);
    expect(client.destroyed).to.be.true;

    try {
      await readExact(client, 40);
      expect.fail('expected reuse after timeout to fail');
    } catch (err) {
      expect(err).to.be.instanceof(AfcConnectionError);
    }
  });
});
