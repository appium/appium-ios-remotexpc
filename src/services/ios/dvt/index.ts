import net from 'node:net';
import { logger } from '@appium/support';

import { createBinaryPlist, parseBinaryPlist } from '../../../lib/plist/index.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';
import { Channel } from './channel.js';
import { ChannelFragmenter } from './channel-fragmenter.js';
import { DTX_CONSTANTS, DTXMessage, MessageAux } from './dtx-message.js';

const log = logger.getLogger('DVTSecureSocketProxyService');

/**
 * DVTSecureSocketProxyService provides access to DTService Hub functionality
 * This includes various instruments and debugging capabilities
 * Based on pymobiledevice3's DvtSecureSocketProxyService
 */
export class DVTSecureSocketProxyService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.instruments.dtservicehub';
  static readonly BROADCAST_CHANNEL = 0;

  private connection: ServiceConnection | null = null;
  private socket: net.Socket | null = null;
  private supportedIdentifiers: PlistDictionary = {};
  private lastChannelCode: number = 0;
  private curMessageId: number = 0;
  private channelCache: Map<string, Channel> = new Map();
  private channelMessages: Map<number, ChannelFragmenter> = new Map();
  private isHandshakeComplete: boolean = false;
  private readBuffer: Buffer = Buffer.alloc(0);

  constructor(address: [string, number]) {
    super(address);
    // Initialize broadcast channel fragmenter
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());
  }

  /**
   * Connect to the DVT service
   */
  async connect(): Promise<void> {
    if (this.connection) {
      log.debug('Already connected to DVT service');
      return;
    }

    const service: Service = {
      serviceName: DVTSecureSocketProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    log.debug(`Connecting to DVT service at ${this.address[0]}:${this.address[1]}`);
    
    // DVT uses DTX binary protocol, not plist protocol
    // So we connect without RSDCheckin (similar to pymobiledevice3's RemoteServer)
    this.connection = await this.startLockdownWithoutCheckin(service);
    this.socket = this.connection.getSocket();
    
    log.debug('Connected to DVT service, socket obtained');
    
    // Remove SSL context if present (similar to pymobiledevice3)
    if ('_sslobj' in this.socket) {
      (this.socket as any)._sslobj = null;
      log.debug('Removed SSL context from socket');
    }

    // Perform DTX protocol handshake
    await this.performHandshake();
  }

  /**
   * Perform DTX handshake
   */
  private async performHandshake(): Promise<void> {
    log.debug('Starting DTX handshake');
    
    const args = new MessageAux();
    args.appendObj({
      'com.apple.private.DTXBlockCompression': 0,
      'com.apple.private.DTXConnection': 1,
    });

    log.debug('Sending _notifyOfPublishedCapabilities: message');
    await this.sendMessage(0, '_notifyOfPublishedCapabilities:', args, false);
    
    log.debug('Waiting for handshake response');
    const [ret, aux] = await this.recvPlist();
    
    log.debug('Received handshake response:', { ret, auxLength: aux?.length });
    
    // The response is a plist with the selector name
    // Extract the actual string value from the archived plist
    let selectorName: string;
    if (typeof ret === 'string') {
      selectorName = ret;
    } else if (ret && typeof ret === 'object' && '$objects' in ret) {
      // NSKeyedArchiver format - extract the string from $objects array
      const objects = (ret as any).$objects;
      if (Array.isArray(objects) && objects.length > 1) {
        selectorName = objects[1]; // First object is usually '$null', second is the actual value
      } else {
        throw new Error(`Invalid handshake response format: ${JSON.stringify(ret)}`);
      }
    } else {
      throw new Error(`Invalid handshake response: ${JSON.stringify(ret)}`);
    }
    
    log.debug('Extracted selector name:', selectorName);
    
    if (selectorName !== '_notifyOfPublishedCapabilities:') {
      throw new Error(`Invalid handshake response selector: ${selectorName}`);
    }
    
    if (!aux || aux.length === 0) {
      throw new Error('Invalid handshake response: missing capabilities in auxiliary data');
    }

    // The capabilities are in the first auxiliary value
    this.supportedIdentifiers = aux[0];
    this.isHandshakeComplete = true;
    
    log.debug('DVT handshake complete. Supported identifiers:', Object.keys(this.supportedIdentifiers));
  }

  /**
   * Get supported identifiers (capabilities)
   */
  getSupportedIdentifiers(): PlistDictionary {
    return this.supportedIdentifiers;
  }

  /**
   * Create a channel for a specific identifier
   * @param identifier The channel identifier (e.g., 'com.apple.instruments.server.services.LocationSimulation')
   * @returns The created channel
   */
  async makeChannel(identifier: string): Promise<Channel> {
    if (!this.isHandshakeComplete) {
      throw new Error('Handshake not complete. Call connect() first.');
    }

    // Check if channel already exists
    if (this.channelCache.has(identifier)) {
      return this.channelCache.get(identifier)!;
    }

    // Create new channel
    this.lastChannelCode++;
    const channelCode = this.lastChannelCode;
    
    const args = new MessageAux();
    args.appendInt(channelCode);
    args.appendObj(identifier);

    await this.sendMessage(0, '_requestChannelWithCode:identifier:', args);
    
    const [ret, _aux] = await this.recvPlist();
    if (ret !== null) {
      throw new Error(`Failed to create channel: ${ret}`);
    }

    // Create channel instance
    const channel = new Channel(channelCode, this);
    this.channelCache.set(identifier, channel);
    this.channelMessages.set(channelCode, new ChannelFragmenter());

    log.debug(`Created channel ${channelCode} for identifier: ${identifier}`);
    
    return channel;
  }

  /**
   * Send a DTX message
   * @param channel The channel code
   * @param selector The method selector (can be null)
   * @param args Optional message arguments
   * @param expectsReply Whether to expect a reply
   */
  async sendMessage(
    channel: number,
    selector: string | null = null,
    args: MessageAux | null = null,
    expectsReply: boolean = true
  ): Promise<void> {
    if (!this.socket) {
      throw new Error('Not connected to DVT service');
    }

    this.curMessageId++;

    // Build auxiliary data with proper plist encoding
    const auxBuffer = args ? this.buildAuxiliaryData(args) : Buffer.alloc(0);

    // Encode selector as plist if provided
    const selectorBuffer = selector ? createBinaryPlist(selector) : Buffer.alloc(0);

    // Build payload header
    let flags = DTX_CONSTANTS.INSTRUMENTS_MESSAGE_TYPE;
    if (expectsReply) {
      flags |= DTX_CONSTANTS.EXPECTS_REPLY_MASK;
    }

    const payloadHeader = DTXMessage.buildPayloadHeader({
      flags,
      auxiliaryLength: auxBuffer.length,
      totalLength: BigInt(auxBuffer.length + selectorBuffer.length),
    });

    // Build message header
    const messageHeader = DTXMessage.buildMessageHeader({
      magic: DTX_CONSTANTS.MESSAGE_HEADER_MAGIC,
      cb: DTX_CONSTANTS.MESSAGE_HEADER_SIZE,
      fragmentId: 0,
      fragmentCount: 1,
      length: DTX_CONSTANTS.PAYLOAD_HEADER_SIZE + auxBuffer.length + selectorBuffer.length,
      identifier: this.curMessageId,
      conversationIndex: 0,
      channelCode: channel,
      expectsReply: expectsReply ? 1 : 0,
    });

    // Send complete message
    const message = Buffer.concat([messageHeader, payloadHeader, auxBuffer, selectorBuffer]);
    
    log.debug(`Sending message ${this.curMessageId} on channel ${channel}: ${selector || 'null'}`, {
      messageSize: message.length,
      auxSize: auxBuffer.length,
      selectorSize: selectorBuffer.length,
      expectsReply,
    });
    
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(message, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    log.debug(`Message ${this.curMessageId} sent successfully`);
  }

  /**
   * Receive a plist message
   * @param channel The channel to receive from
   * @returns Tuple of [data, auxiliary]
   */
  async recvPlist(channel: number = DVTSecureSocketProxyService.BROADCAST_CHANNEL): Promise<[any, any[]]> {
    const [data, aux] = await this.recvMessage(channel);
    
    let decodedData = null;
    if (data && data.length > 0) {
      try {
        decodedData = parseBinaryPlist(data);
      } catch (error) {
        log.warn('Failed to parse plist data:', error);
        log.debug('Raw data:', data.toString('hex').substring(0, 100));
      }
    }

    return [decodedData, aux];
  }

  /**
   * Receive a raw message
   * @param channel The channel to receive from
   * @returns Tuple of [data, auxiliary]
   */
  async recvMessage(channel: number = DVTSecureSocketProxyService.BROADCAST_CHANNEL): Promise<[Buffer | null, any[]]> {
    const packetData = await this.recvPacketFragments(channel);
    
    log.debug(`Packet data size: ${packetData.length}`);
    log.debug(`First 64 bytes of packet: ${packetData.subarray(0, Math.min(64, packetData.length)).toString('hex')}`);
    
    // Parse payload header
    const payloadHeader = DTXMessage.parsePayloadHeader(packetData);
    
    log.debug('Payload header:', {
      flags: payloadHeader.flags.toString(16),
      auxiliaryLength: payloadHeader.auxiliaryLength,
      totalLength: payloadHeader.totalLength.toString(),
    });
    
    // Check for compression
    const compression = (payloadHeader.flags & 0xff000) >> 12;
    if (compression) {
      throw new Error('Compressed messages not supported yet');
    }

    let offset = DTX_CONSTANTS.PAYLOAD_HEADER_SIZE;
    
    // Parse auxiliary data if present
    let aux: any[] = [];
    if (payloadHeader.auxiliaryLength > 0) {
      log.debug(`Reading auxiliary data from offset ${offset}, length ${payloadHeader.auxiliaryLength}`);
      const auxBuffer = packetData.subarray(offset, offset + payloadHeader.auxiliaryLength);
      log.debug(`First 64 bytes of aux buffer: ${auxBuffer.subarray(0, Math.min(64, auxBuffer.length)).toString('hex')}`);
      
      // The auxiliary structure has a header, then bplist data
      // Based on hex analysis, bplist starts at offset 24
      // Structure: [magic:8][size:8][count/type:8][plist data...]
      try {
        const magic = auxBuffer.readBigUInt64LE(0);
        const size = Number(auxBuffer.readBigUInt64LE(8));
        log.debug(`Aux header: magic=0x${magic.toString(16)}, size=${size}`);
        
        // The bplist data starts after the header
        // Let's search for "bplist00" to find the exact offset
        const bplistMagic = 'bplist00';
        const hexStr = auxBuffer.toString('ascii', 0, Math.min(100, auxBuffer.length));
        const bplistOffset = hexStr.indexOf(bplistMagic);
        
        if (bplistOffset >= 0) {
          log.debug(`Found bplist magic at offset ${bplistOffset}`);
          const plistBuffer = auxBuffer.subarray(bplistOffset);
          const auxPlist = parseBinaryPlist(plistBuffer);
          log.debug('Successfully parsed auxiliary plist');
          
          // The plist should be an array of values
          if (Array.isArray(auxPlist)) {
            aux = auxPlist;
            log.debug(`Extracted ${aux.length} auxiliary values`);
          } else {
            log.debug('Auxiliary plist is not an array, wrapping it');
            aux = [auxPlist];
          }
        } else {
          log.warn('Could not find bplist magic in auxiliary buffer');
          aux = [];
        }
      } catch (error) {
        log.warn('Failed to parse auxiliary buffer:', error);
        aux = [];
      }
      
      offset += payloadHeader.auxiliaryLength;
    }

    // Get object data
    const objSize = Number(payloadHeader.totalLength) - payloadHeader.auxiliaryLength;
    log.debug(`Object size: ${objSize}, reading from offset ${offset}`);
    const data = objSize > 0 ? packetData.subarray(offset, offset + objSize) : null;
    
    if (data) {
      log.debug(`First 32 bytes of object data: ${data.subarray(0, Math.min(32, data.length)).toString('hex')}`);
    }

    return [data, aux];
  }

  /**
   * Receive packet fragments until a complete message is available
   */
  private async recvPacketFragments(channel: number): Promise<Buffer> {
    while (true) {
      const fragmenter = this.channelMessages.get(channel);
      if (!fragmenter) {
        throw new Error(`No fragmenter for channel ${channel}`);
      }

      // Check if we have a complete message
      const message = fragmenter.get();
      if (message) {
        log.debug(`Returning complete message for channel ${channel}, size: ${message.length}`);
        return message;
      }

      // Read next message header
      log.debug(`Reading message header for channel ${channel}`);
      const headerData = await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
      const header = DTXMessage.parseMessageHeader(headerData);
      
      log.debug(`Received message header:`, {
        channelCode: header.channelCode,
        identifier: header.identifier,
        fragmentId: header.fragmentId,
        fragmentCount: header.fragmentCount,
        length: header.length,
      });

      // Handle channel routing
      const receivedChannel = Math.abs(header.channelCode);
      
      if (!this.channelMessages.has(receivedChannel)) {
        this.channelMessages.set(receivedChannel, new ChannelFragmenter());
      }

      // Update current message ID if needed
      if (!header.conversationIndex && header.identifier > this.curMessageId) {
        this.curMessageId = header.identifier;
      }

      // Skip first fragment header for multi-fragment messages
      if (header.fragmentCount > 1 && header.fragmentId === 0) {
        log.debug('Skipping first fragment header for multi-fragment message');
        continue;
      }

      // Read message data
      log.debug(`Reading message data of length ${header.length}`);
      const messageData = await this.readExact(header.length);
      
      // Add fragment to appropriate channel
      const targetFragmenter = this.channelMessages.get(receivedChannel)!;
      targetFragmenter.addFragment(header, messageData);
      
      log.debug(`Added fragment to channel ${receivedChannel}`);
    }
  }

  /**
   * Read exact number of bytes from socket
   */
  private async readExact(length: number): Promise<Buffer> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    log.debug(`readExact: requesting ${length} bytes, buffer has ${this.readBuffer.length} bytes`);

    // Keep reading until we have enough data
    while (this.readBuffer.length < length) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const onData = (data: Buffer) => {
          this.socket!.off('data', onData);
          this.socket!.off('error', onError);
          resolve(data);
        };

        const onError = (err: Error) => {
          this.socket!.off('data', onData);
          this.socket!.off('error', onError);
          reject(err);
        };

        this.socket!.once('data', onData);
        this.socket!.once('error', onError);
      });

      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      log.debug(`readExact: received chunk of ${chunk.length} bytes, buffer now has ${this.readBuffer.length} bytes`);
    }

    // Extract the exact amount requested
    const result = this.readBuffer.subarray(0, length);
    this.readBuffer = this.readBuffer.subarray(length);
    
    log.debug(`readExact: completed, returning ${result.length} bytes, ${this.readBuffer.length} bytes remaining in buffer`);
    return result;
  }

  /**
   * Build auxiliary data with proper plist encoding for objects
   */
  private buildAuxiliaryData(args: MessageAux): Buffer {
    // Get the raw values from MessageAux
    const values = args.getValues();
    
    if (values.length === 0) {
      return Buffer.alloc(0);
    }

    // First, build all the auxiliary items
    const itemBuffers: Buffer[] = [];
    
    // Write each auxiliary value
    for (const auxValue of values) {
      // Write empty dictionary marker
      const dictMarker = Buffer.alloc(4);
      dictMarker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
      itemBuffers.push(dictMarker);

      // Write type
      const typeBuffer = Buffer.alloc(4);
      typeBuffer.writeUInt32LE(auxValue.type, 0);
      itemBuffers.push(typeBuffer);

      // Write value based on type
      switch (auxValue.type) {
        case DTX_CONSTANTS.AUX_TYPE_INT32: {
          const valueBuffer = Buffer.alloc(4);
          valueBuffer.writeUInt32LE(auxValue.value, 0);
          itemBuffers.push(valueBuffer);
          break;
        }
        
        case DTX_CONSTANTS.AUX_TYPE_INT64: {
          const valueBuffer = Buffer.alloc(8);
          valueBuffer.writeBigUInt64LE(BigInt(auxValue.value), 0);
          itemBuffers.push(valueBuffer);
          break;
        }
        
        case DTX_CONSTANTS.AUX_TYPE_OBJECT: {
          // Encode object as binary plist
          const encodedPlist = createBinaryPlist(auxValue.value);
          // For objects, we need to write the length first as a 32-bit integer
          const lengthBuffer = Buffer.alloc(4);
          lengthBuffer.writeUInt32LE(encodedPlist.length, 0);
          itemBuffers.push(lengthBuffer);
          itemBuffers.push(encodedPlist);
          break;
        }
        
        default:
          throw new Error(`Unsupported auxiliary type: ${auxValue.type}`);
      }
    }

    // Calculate total size of auxiliary items
    const itemsData = Buffer.concat(itemBuffers);
    
    // Write header: magic + total size of following data (Prefixed structure in Python)
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
    header.writeBigUInt64LE(BigInt(itemsData.length), 8); // Total size, not count!
    
    return Buffer.concat([header, itemsData]);
  }

  /**
   * Parse auxiliary data from buffer
   */
  private parseAuxiliaryData(buffer: Buffer): any[] {
    if (buffer.length === 0) {
      return [];
    }

    try {
      // Parse the auxiliary structure
      let offset = 0;
      const values: any[] = [];

      // Read magic
      const magic = buffer.readBigUInt64LE(offset);
      if (magic !== BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC)) {
        log.warn(`Invalid auxiliary magic: ${magic}, skipping auxiliary parsing`);
        return [];
      }
      offset += 8;

      // Read total size of auxiliary data (not count!)
      // This is the "Prefixed" structure in Python
      const totalSize = Number(buffer.readBigUInt64LE(offset));
      offset += 8;

      log.debug(`Parsing auxiliary data, total size: ${totalSize}`);
      
      const endOffset = offset + totalSize;

      // Read auxiliary items until we reach the end
      while (offset < endOffset) {
        // Read empty dictionary marker
        const emptyDict = buffer.readUInt32LE(offset);
        offset += 4;
        
        if (emptyDict !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
          // If not empty dictionary marker, this is the type directly
          offset -= 4;
        }

        // Read type
        const type = buffer.readUInt32LE(offset);
        offset += 4;

        // Read value based on type
        let value: any;
        switch (type) {
          case DTX_CONSTANTS.AUX_TYPE_INT32:
            value = buffer.readUInt32LE(offset);
            offset += 4;
            break;
          
          case DTX_CONSTANTS.AUX_TYPE_INT64:
            value = Number(buffer.readBigUInt64LE(offset));
            offset += 8;
            break;
          
          case DTX_CONSTANTS.AUX_TYPE_OBJECT: {
            // Read length prefix
            const length = buffer.readUInt32LE(offset);
            offset += 4;
            
            // Read plist data
            const plistData = buffer.subarray(offset, offset + length);
            offset += length;
            
            // Parse plist
            try {
              value = parseBinaryPlist(plistData);
            } catch (error) {
              log.warn('Failed to parse plist in auxiliary data:', error);
              value = plistData;
            }
            break;
          }
          
          default:
            log.warn(`Unknown auxiliary type: ${type}`);
            break;
        }

        values.push(value);
      }

      log.debug(`Parsed ${values.length} auxiliary values`);
      return values;
    } catch (error) {
      log.warn('Failed to parse auxiliary data:', error);
      return [];
    }
  }

  /**
   * Close the DVT service connection
   */
  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    // Send channel canceled messages for all active channels
    const activeCodes = Array.from(this.channelMessages.keys()).filter(code => code > 0);
    
    if (activeCodes.length > 0) {
      const args = new MessageAux();
      for (const code of activeCodes) {
        args.appendInt(code);
      }

      try {
        await this.sendMessage(
          DVTSecureSocketProxyService.BROADCAST_CHANNEL,
          '_channelCanceled:',
          args,
          false
        );
      } catch (error) {
        log.debug('Error sending channel canceled message:', error);
      }
    }

    // Close connection
    this.connection.close();
    this.connection = null;
    this.socket = null;
    this.isHandshakeComplete = false;
    this.channelCache.clear();
    this.channelMessages.clear();
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());

    log.debug('DVT service connection closed');
  }
}

// Export all DVT-related types and classes
export { Channel, ChannelFragmenter, DTXMessage, MessageAux, DTX_CONSTANTS };
export type { DTXMessageHeader, DTXMessagePayloadHeader, MessageAuxValue } from './dtx-message.js';
