import net from 'node:net';

export interface ServiceConnectionOptions {
  keepAlive?: boolean;
  createConnectionTimeout?: number;
}

/**
 * ServiceConnection for communicating with Apple device services over TCP
 */
export class ServiceConnection {
  private readonly socket: net.Socket;
  private buffer: Buffer;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
    });
  }

  /**
   * Creates a TCP connection to the specified host and port
   */
  static createUsingTCP(
    hostname: string,
    port: string,
    options?: ServiceConnectionOptions,
  ): Promise<ServiceConnection> {
    const keepAlive = options?.keepAlive ?? true;
    const createConnectionTimeout = options?.createConnectionTimeout ?? 30000;

    return new Promise<ServiceConnection>((resolve, reject) => {
      const socket = net.createConnection(
        { host: hostname, port: Number(port) },
        () => {
          socket.setTimeout(0);
          if (keepAlive) socket.setKeepAlive(true);
          resolve(new ServiceConnection(socket));
        },
      );

      socket.setTimeout(createConnectionTimeout, () => {
        socket.destroy();
        reject(new Error('Connection timed out'));
      });

      socket.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Creates a plist XML string from a JavaScript object
   */
  static createPlist(obj: Record<string, any>): string {
    function convert(value: any): string {
      if (typeof value === 'number') return `<integer>${value}</integer>`;
      if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
      if (typeof value === 'string') return `<string>${value}</string>`;
      if (Array.isArray(value)) {
        return `<array>${value.map((item) => convert(item)).join('')}</array>`;
      }
      if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value)
          .map(([k, v]) => `<key>${k}</key>${convert(v)}`)
          .join('');
        return `<dict>${entries}</dict>`;
      }
      return '<string></string>';
    }

    const body = Object.entries(obj)
      .map(([key, val]) => `<key>${key}</key>${convert(val)}`)
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"\n"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>${body}</dict>\n</plist>\n`;
  }

  /**
   * Parses a plist response from a buffer
   */
  static parsePlistResponse(
    payload: Buffer,
    headerSize: number = 4,
  ): Record<string, any>[] | null {
    const xmlStr = payload.slice(headerSize).toString('utf8');
    try {
      // We need to handle multiple plist documents concatenated together
      // Let's use a simple approach with string splitting to handle this case

      // Find all plist start and end positions
      const plists: string[] = [];
      let currentPos = 0;

      // Find all complete plists in the string
      while (true) {
        const plistStart = xmlStr.indexOf('<plist', currentPos);
        if (plistStart === -1) break;

        const plistEnd = xmlStr.indexOf('</plist>', plistStart);
        if (plistEnd === -1) break;

        // Extract the complete plist document including XML declaration
        const xmlDeclStart = Math.max(
          0,
          xmlStr.lastIndexOf('<?xml', plistStart),
        );
        const fullPlist = xmlStr.substring(xmlDeclStart, plistEnd + 8); // 8 is the length of '</plist>'
        plists.push(fullPlist);

        currentPos = plistEnd + 8;
      }

      if (plists.length === 0) {
        console.error('No complete plist found in response');
        return null;
      }

      // Process each plist using a simple parser since DOMParser with getElementsByTagName isn't available
      const results: Record<string, any>[] = [];

      for (const plistXml of plists) {
        // Find dict elements
        const dictStart = plistXml.indexOf('<dict>');
        const dictEnd = plistXml.lastIndexOf('</dict>');

        if (dictStart === -1 || dictEnd === -1) continue;

        const dictContent = plistXml.substring(dictStart + 6, dictEnd);
        const obj: Record<string, any> = {};

        // Use regex to find all key-value pairs
        const keyValueRegex = /<key>(.*?)<\/key>\s*<([^>]+)>(.*?)<\/\2>/g;
        let match;

        while ((match = keyValueRegex.exec(dictContent)) !== null) {
          const [_, key, type, value] = match;

          switch (type) {
            case 'integer':
              obj[key] = parseInt(value, 10);
              break;
            case 'real':
              obj[key] = parseFloat(value);
              break;
            case 'true':
              obj[key] = true;
              break;
            case 'false':
              obj[key] = false;
              break;
            case 'string':
            default:
              obj[key] = value;
              break;
          }
        }

        // Handle special cases that don't have closing tags
        const booleanKeyRegex = /<key>(.*?)<\/key>\s*<(true|false)\/>/g;
        while ((match = booleanKeyRegex.exec(dictContent)) !== null) {
          const [_, key, value] = match;
          obj[key] = value === 'true';
        }

        if (Object.keys(obj).length > 0) {
          results.push(obj);
        }
      }

      return results.length > 0 ? results : null;
    } catch (error) {
      console.error('Failed to parse response:', error);
      return null;
    }
  }

  /**
   * Sends a plist request to the device and returns the response
   */
  sendPlistRequest(
    requestObj: Record<string, any>,
  ): Promise<Record<string, any>[] | null> {
    return new Promise((resolve, reject) => {
      const requestPlist = ServiceConnection.createPlist(requestObj);
      const payloadBuffer = Buffer.from(requestPlist, 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payloadBuffer.length, 0);
      const message = Buffer.concat([header, payloadBuffer]);

      this.socket.write(message, (err) => {
        if (err) {
          return reject(err);
        }

        let responseBuffer = Buffer.alloc(0);

        const onData = (data: Buffer) => {
          responseBuffer = Buffer.concat([responseBuffer, data]);
          console.log('responseBuffer', responseBuffer.toString('utf8'));
          if (responseBuffer.toString('utf8').includes('</plist>')) {
            this.socket.removeListener('data', onData);
            // Skip a 16-byte header when parsing the response.
            resolve(ServiceConnection.parsePlistResponse(responseBuffer, 16));
          }
        };

        this.socket.on('data', onData);
        this.socket.once('error', reject);
      });
    });
  }

  /**
   * Gets the underlying socket
   */
  getSocket(): net.Socket {
    return this.socket;
  }

  /**
   * Closes the connection
   */
  close(): void {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }
}

export default ServiceConnection;
