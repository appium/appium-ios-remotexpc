import { EventEmitter } from 'events';

import ServiceConnection from '../../../ServiceConnection.js';

// Define interfaces for clarity
interface Packet {
  protocol: 'TCP' | 'UDP';
  src: string;
  dst: string;
  sourcePort: number;
  destPort: number;
  payload: Buffer;
}

interface TunnelManager extends EventEmitter {
  on(event: 'data', listener: (packet: Packet) => void): this;
}

interface Service {
  serviceName: string;
  port: string;
}

/**
 * SyslogService provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService {
  private address: [string, number]; // [host, port]

  /**
   * Creates a new SyslogService instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    this.address = address;
  }

  /**
   * Starts capturing syslog data from the device
   * @param Service
   * @param pid Process ID to filter (-1 for all processes)
   * @param tunnelManager Tunnel manager to handle data packets
   * @returns Promise resolving to the initial response from the service
   */
  async start(
    Service: Service,
    pid: number = -1,
    tunnelManager: TunnelManager,
  ): Promise<void> {
    // Attach listener to capture network packets
    this.attachPacketListener(tunnelManager);

    // Connect to the os_trace_relay service
    const conn = await this.startLockdownService(Service);

    // Start the activity to receive syslog messages
    const request = {
      Request: 'StartActivity',
      MessageFilter: 65535,
      Pid: pid,
      StreamFlags: 60,
    };

    const response = await conn.sendPlistRequest(request);
    console.log('Syslog capture started:', response);
  }

  async restart(Service: Service) {
    try {
      // Connect to the diagnostics service for restart.
      const conn = await this.startLockdownService(Service);
      // Create a plist request for restart.
      const request = { Request: 'Restart' };
      // Send the restart request.
      const res = await conn.sendPlistRequest(request);
      console.log('Restart response:', res);
    } catch (error) {
      console.error('Error during restart:', error);
    }
  }

  /**
   * Attaches a listener to the tunnel manager to process incoming packets
   * @param tunnelManager Manager handling network packets
   */
  private attachPacketListener(tunnelManager: TunnelManager): void {
    tunnelManager.on('data', (packet: Packet) => {
      if (packet.protocol === 'TCP') {
        // Filter packets by checking if they contain printable text
        if (this.isMostlyPrintable(packet.payload)) {
          console.log('Received syslog-like TCP packet:');
          console.log('  Source:', packet.src);
          console.log('  Destination:', packet.dst);
          console.log('  Source port:', packet.sourcePort);
          console.log('  Destination port:', packet.destPort);
          console.log('  Payload length:', packet.payload.length);
          console.log(
            '  Message:',
            packet.payload.toString().replace(/[^\x20-\x7E]/g, ''),
          );
        } else {
          console.log('TCP packet not mostly printable, ignoring.');
        }
      } else if (packet.protocol === 'UDP') {
        // Process UDP packets if needed
        console.log('Received UDP packet (not filtered here):', packet);
      }
    });
  }

  /**
   * Determines if a buffer contains mostly printable ASCII characters
   * @param buffer Buffer to analyze
   * @returns True if more than 50% of characters are printable ASCII
   */
  private isMostlyPrintable(buffer: Buffer): boolean {
    try {
      const str = buffer.toString('utf8');
      if (!str || str.length === 0) return false;

      let printableCount = 0;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        // ASCII printable characters (space through ~)
        if (code >= 32 && code <= 126) {
          printableCount++;
        }
      }

      return printableCount / str.length > 0.5;
    } catch (error) {
      console.log(error);
      return false;
    }
  }

  /**
   * Starts a lockdown service without sending a check-in message
   * @returns Promise resolving to a ServiceConnection
   * @param service
   */
  private async startLockdownWithoutCheckin(
    service: Service,
  ): Promise<ServiceConnection> {
    // Get the port for the requested service
    const port = service.port;
    return ServiceConnection.createUsingTCP(this.address[0], port);
  }

  /**
   * Starts a lockdown service with proper check-in
   * @returns Promise resolving to a ServiceConnection
   * @param service
   */
  private async startLockdownService(
    service: Service,
  ): Promise<ServiceConnection> {
    const connection = await this.startLockdownWithoutCheckin(service);
    const checkin = {
      Label: 'appium-internal',
      ProtocolVersion: '2',
      Request: 'RSDCheckin',
    };

    const response = await connection.sendPlistRequest(checkin);
    console.log('Service check-in response:', response);
    return connection;
  }
}

export default SyslogService;
