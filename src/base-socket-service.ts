import {EventEmitter} from 'node:events';
import {Socket} from 'node:net';
import {type Readable} from 'node:stream';

import {getLogger} from './lib/logger.js';

const log = getLogger('BaseSocketService');

class BaseSocketService extends EventEmitter {
  protected _socketClient: Socket;
  protected _isConnected: boolean = false;

  /**
   * @param socketClient
   */
  constructor(socketClient: Socket) {
    super();
    this._socketClient = socketClient;

    // Check if already connected
    this._isConnected = !socketClient.connecting && !socketClient.destroyed;

    // if not connected and it's a raw socket
    if (!this._isConnected && socketClient instanceof Socket) {
      this._socketClient.once('connect', () => {
        this._isConnected = true;
        this.emit('connect');
      });
    }

    // setup basic error handling
    // Only re-emit if someone is listening, otherwise this throws (unhandled 'error') instead of
    // just leaving the error on the underlying socket. Log it so it isn't silently dropped.
    this._socketClient.on('error', (err) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      } else {
        log.error(`Unhandled socket error: ${err}`);
      }
    });

    this._socketClient.on('close', () => {
      this._isConnected = false;
      this.emit('close');
    });
  }

  _assignClientFailureHandlers(...sourceStreams: Readable[]): void {
    for (const evt of ['close', 'end']) {
      this._socketClient.once(evt, () => {
        sourceStreams.map((s) => {
          s.unpipe(this._socketClient);
        });
      });
    }
  }

  close(): void {
    if (!this._socketClient.destroyed) {
      this._socketClient.end();
    }
  }
}

export {BaseSocketService};
