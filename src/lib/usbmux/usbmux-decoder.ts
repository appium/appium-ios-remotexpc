import { Transform, type TransformCallback } from 'stream';
import { plist } from '@appium/support';

const HEADER_LENGTH = 16;

export interface UsbmuxHeader {
    length: number;
    version: number;
    type: number;
    tag: number;
}

export interface DecodedUsbmux {
    header: UsbmuxHeader;
    payload: any;
}

export class UsbmuxDecoder extends Transform {
    private buffer: Buffer = Buffer.alloc(0);

    constructor() {
        super({ objectMode: true });
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        // Append the new chunk to the internal buffer
        this.buffer = Buffer.concat([this.buffer, chunk]);

        // Process complete messages in the buffer
        while (this.buffer.length >= HEADER_LENGTH) {
            // Read header length field (total length of the message)
            const totalLength = this.buffer.readUInt32LE(0);

            // Check if we have received the full message
            if (this.buffer.length < totalLength) {
                break; // Wait for more data
            }

            // Extract the full message
            const message = this.buffer.slice(0, totalLength);
            this._decode(message);

            // Remove the processed message from the buffer
            this.buffer = this.buffer.slice(totalLength);
        }
        callback();
    }

    private _decode(data: Buffer): void {
        const header = {
            length: data.readUInt32LE(0),
            version: data.readUInt32LE(4),
            type: data.readUInt32LE(8),
            tag: data.readUInt32LE(12)
        };

        const payload = data.slice(HEADER_LENGTH);
        this.push({ header, payload: plist.parsePlist(payload) } as DecodedUsbmux);
    }
}