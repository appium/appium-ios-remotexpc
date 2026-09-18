import assert from 'node:assert/strict';
import {Socket} from 'node:net';
import {describe, it} from 'node:test';

import {BaseSocketService} from '../../src/base-socket-service.js';

describe('BaseSocketService', function () {
  it('does not throw when the underlying socket errors and no one is listening', function () {
    const socketClient = new Socket();
    new BaseSocketService(socketClient);

    // Regression for https://github.com/appium/appium-ios-remotexpc/issues/330:
    // re-emitting onto a listener-less EventEmitter throws and crashes the process.
    assert.doesNotThrow(() => socketClient.emit('error', new Error('write EPIPE')));
  });

  it('still forwards the error to consumers who do listen', function () {
    const socketClient = new Socket();
    const service = new BaseSocketService(socketClient);

    let received: Error | undefined;
    service.on('error', (err: Error) => {
      received = err;
    });

    const err = new Error('write EPIPE');
    socketClient.emit('error', err);

    assert.equal(received, err);
  });
});
