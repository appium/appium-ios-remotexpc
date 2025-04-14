
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

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
        if(!this._isConnected && socketClient instanceof Socket) {
            this._socketClient.once('connect', ()=> {
                this._isConnected = true;
                this.emit('connect');
            });
        }

        // setup basic error handling
        this._socketClient.on('error', (err) => {
            this.emit('error', err);
        });

        this._socketClient.on('close', () => {
            this._isConnected  = false;
            this.emit('close');
        });
    }

    _assignClientFailureHandlers(...sourceStreams: Readable[]){
        for (const evt of ['close', 'end']) {
            this._socketClient.once(evt, ()=> {
                sourceStreams.map((s) => {
                    s.unpipe(this._socketClient);
                });
            });
        }
    }

    close() {
        if(!this._socketClient.destroyed) {
            this._socketClient.end();
        }
    }
}


export { BaseSocketService };