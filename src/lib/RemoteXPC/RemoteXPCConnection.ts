import net from 'node:net';

import Handshake from './Handshake.js';

interface Service {
  serviceName: string;
  port: string;
}

interface ServicesResponse {
  services: Service[];
}

class RemoteXPCConnection {
  private readonly address: [string, number];
  private socket: net.Socket | undefined;
  private handshake: Handshake | undefined;
  private _isConnected: boolean;
  private _services: Service[] | undefined;

  constructor(address: [string, number]) {
    this.address = address;
    this.socket = undefined;
    this.handshake = undefined;
    this._isConnected = false;
    this._services = undefined;
  }

  /**
   * Connect to the remote device and perform handshake
   * @returns Promise that resolves with the list of available services
   */
  async connect(): Promise<ServicesResponse> {
    if (this._isConnected) {
      throw new Error('Already connected');
    }

    return new Promise((resolve, reject) => {
      try {
        this.socket = net.connect({
          host: this.address[0],
          port: this.address[1],
          family: 6,
        });

        this.socket.setNoDelay(true);
        this.socket.setKeepAlive(true);

        this.socket.once('error', (error) => {
          console.error('Connection error:', error);
          this._isConnected = false;
          reject(error);
        });

        // Handle incoming data
        this.socket.on('data', (data) => {
          // Process incoming frames
          if (data.length > 100) {
            // @ts-ignore
            const message = Buffer.from(data, 'hex');
            const response = message.toString('utf8');
            const servicesResponse = extractServices(response);
            this._services = servicesResponse.services;
            resolve(servicesResponse);
          }
        });

        this.socket.on('close', () => {
          console.log('Socket closed');
          this._isConnected = false;
        });

        this.socket.once('connect', async () => {
          try {
            this._isConnected = true;
            if (this.socket) {
              this.handshake = new Handshake(this.socket);
              // Once handshake is successful we can get
              // peer-info and get ports for lockdown in RSD
              await this.handshake.perform();
            }
          } catch (error) {
            console.error('Handshake failed:', error);
            await this.close();
            reject(error);
          }
        });
      } catch (error) {
        console.error('Failed to create connection:', error);
        reject(error);
      }
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      return new Promise((resolve) => {
        this.socket!.end(() => {
          this.socket = undefined;
          this._isConnected = false;
          this.handshake = undefined;
          this._services = undefined;
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  /**
   * Get the list of available services
   */
  getServices(): Service[] {
    if (!this._services) {
      throw new Error('Not connected or services not available');
    }
    return this._services;
  }

  /**
   * List all available services
   */
  listAllServices(): Service[] {
    return this.getServices();
  }

  /**
   * Find a service by name
   * @param serviceName The name of the service to find
   * @returns The service or throws an error if not found
   */
  findService(serviceName: string): Service {
    const services = this.getServices();
    const service = services.find(
      (service) => service.serviceName === serviceName,
    );
    if (!service) {
      throw new Error(`Service ${serviceName} not found, 
        Check if the device is locked.`);
    }
    return service;
  }
}

/**
 * Extract services from the response
 */
function extractServices(response: string): ServicesResponse {
  const regex = /com\.apple(?:\.[\w-]+)+|Port[^0-9]*(\d+)/g;

  const items: Array<{ type: string; value: string; index: number }> = [];
  for (const match of response.matchAll(regex)) {
    // match.index gives the position in the string
    if (match[0].startsWith('com.apple')) {
      items.push({ type: 'service', value: match[0], index: match.index });
    } else if (match[0].startsWith('Port')) {
      // The captured group (match[1]) is the port number.
      items.push({ type: 'port', value: match[1], index: match.index });
    }
  }

  const services: Service[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === 'service') {
      // If the next item is also a service, skip the current one.
      if (i + 1 < items.length && items[i + 1].type === 'service') {
        continue;
      }
      // Look ahead for the next port occurrence.
      let port: string | undefined;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].type === 'port') {
          port = items[j].value;
          break;
        }
      }
      // If no port is found, default to an empty string.
      services.push({ serviceName: items[i].value, port: port || '' });
    }
  }
  return { services };
}

export default RemoteXPCConnection;
export { type Service, type ServicesResponse };
