import { Socket } from 'net';

import createPlist from './plist-creator.js';
import parsePlist from './plist-parser.js';

/**
 * Send a plist request to usbmuxd and receive response
 * @param client - Socket connected to usbmuxd
 * @param requestObj - Request object
 * @param type - Request type for logging
 * @param timeout - Timeout for response in ms
 * @returns - Parsed response
 */
export function sendUsbmuxPlistRequest(
  client: Socket,
  requestObj: Record<string, any>,
  type: string = 'Request',
  timeout: number = 5000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const requestPlist = createPlist(requestObj);
    console.log(`\n📡 Sending ${type} PLIST Request:\n`, requestPlist);

    const payloadBuffer = Buffer.from(requestPlist, 'utf8');

    // 16-byte header + plist payload (usbmuxd specific format)
    const length = 16 + payloadBuffer.length;
    const header = Buffer.alloc(16);
    header.writeUInt32LE(length, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(8, 8);
    header.writeUInt32LE(1, 12);

    client.write(Buffer.concat([header, payloadBuffer]));

    let responseBuffer = Buffer.alloc(0);

    // Set a timeout
    const timeoutId = setTimeout(() => {
      client.removeListener('data', onData);
      reject(
        new Error(
          `Timeout waiting for response with tag ${
            requestObj.tag || 0
          } after ${timeout}ms`,
        ),
      );
    }, timeout);

    const onData = (data: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, data]);

      try {
        // Check if we have a complete plist response
        const bufferString = responseBuffer.toString();
        if (bufferString.includes('</plist>')) {
          // We have a complete response
          clearTimeout(timeoutId);
          client.removeListener('data', onData);

          // Find start of plist (skipping the header)
          const plistStart = bufferString.indexOf('<?xml');
          if (plistStart >= 0) {
            const xmlStr = bufferString.substring(plistStart);
            const result = parsePlist(xmlStr);
            console.log(
              `\n📩 Received ${type} PLIST Response:\n`,
              JSON.stringify(result, null, 2),
            );
            resolve(result);
          } else {
            // Fallback to assuming header is exactly 16 bytes
            const xmlStr = responseBuffer.slice(16).toString();
            const result = parsePlist(xmlStr);
            console.log(
              `\n📩 Received ${type} PLIST Response:\n`,
              JSON.stringify(result, null, 2),
            );
            resolve(result);
          }
        }
      } catch (err) {
        console.warn(
          'Error processing usbmux data (will continue waiting for more data):',
          err,
        );
        // Continue waiting for more data
      }
    };

    client.on('data', onData);

    client.once('error', (err) => {
      clearTimeout(timeoutId);
      client.removeListener('data', onData);
      reject(err);
    });

    client.once('close', () => {
      clearTimeout(timeoutId);
      client.removeListener('data', onData);
      reject(new Error('Socket closed before receiving response'));
    });
  });
}

/**
 * Function to swap bytes for a 16-bit value
 * Used for usbmuxd port numbers
 */
export function byteSwap16(value: number): number {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
}
