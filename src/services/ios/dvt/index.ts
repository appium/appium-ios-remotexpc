import net from 'node:net';
import { logger } from '@appium/support';

import { createBinaryPlist, parseBinaryPlist } from '../../../lib/plist/index.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { PlistUID } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';
import { Channel } from './channel.js';
import { ChannelFragmenter } from './channel-fragmenter.js';
import { DTX_CONSTANTS, DTXMessage, MessageAux } from './dtx-message.js';

const log = logger.getLogger('DVTSecureSocketProxyService');

/**
 * DVTSecureSocketProxyService provides access to Apple's DTServiceHub functionality
 * This service enables various instruments and debugging capabilities through the DTX protocol
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
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());
  }

  /**
   * Connect to the DVT service and perform handshake
   */
  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    const service: Service = {
      serviceName: DVTSecureSocketProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    // DVT uses DTX binary protocol, connect without plist-based RSDCheckin
    this.connection = await this.startLockdownWithoutCheckin(service);
    this.socket = this.connection.getSocket();

    // Remove SSL context if present for raw DTX communication
    if ('_sslobj' in this.socket) {
      (this.socket as any)._sslobj = null;
    }

    await this.performHandshake();
  }

  /**
   * Perform DTX protocol handshake to establish connection and retrieve capabilities
   */
  private async performHandshake(): Promise<void> {
    const args = new MessageAux();
    args.appendObj({
      'com.apple.private.DTXBlockCompression': 0,
      'com.apple.private.DTXConnection': 1,
    });

    await this.sendMessage(0, '_notifyOfPublishedCapabilities:', args, false);

    const [retData, aux] = await this.recvMessage();
    const ret = retData ? parseBinaryPlist(retData) : null;

    // Extract selector name from NSKeyedArchiver response
    let selectorName: string;
    if (typeof ret === 'string') {
      selectorName = ret;
    } else if (ret && typeof ret === 'object' && '$objects' in ret) {
      const objects = (ret as any).$objects;
      if (Array.isArray(objects) && objects.length > 1) {
        selectorName = objects[1];
      } else {
        throw new Error(`Invalid handshake response format`);
      }
    } else {
      throw new Error(`Invalid handshake response`);
    }

    if (selectorName !== '_notifyOfPublishedCapabilities:') {
      throw new Error(`Invalid handshake response selector: ${selectorName}`);
    }

    if (!aux || aux.length === 0) {
      throw new Error('Invalid handshake response: missing capabilities');
    }

    // Extract capabilities dictionary from NSKeyedArchiver auxiliary data
    const capabilities = aux[0];

    if (capabilities && typeof capabilities === 'object' && '$objects' in capabilities) {
      const objects = capabilities.$objects;

      if (Array.isArray(objects) && objects.length > 1) {
        const dictObj = objects[1];

        if (dictObj && typeof dictObj === 'object' && 'NS.keys' in dictObj && 'NS.objects' in dictObj) {
          // NSDictionary format with key/value references
          const keysRef = dictObj['NS.keys'];
          const valuesRef = dictObj['NS.objects'];

          if (Array.isArray(keysRef) && Array.isArray(valuesRef)) {
            this.supportedIdentifiers = {};
            for (let i = 0; i < keysRef.length; i++) {
              const key = objects[keysRef[i]];
              const value = objects[valuesRef[i]];
              if (typeof key === 'string') {
                this.supportedIdentifiers[key] = value;
              }
            }
          }
        } else {
          // Array of capability strings
          this.supportedIdentifiers = {};
          for (let i = 1; i < objects.length; i++) {
            const obj = objects[i];
            if (typeof obj === 'string' && obj !== '$null') {
              this.supportedIdentifiers[obj] = true;
            }
          }
        }
      } else {
        this.supportedIdentifiers = {};
      }
    } else {
      this.supportedIdentifiers = capabilities || {};
    }

    this.isHandshakeComplete = true;

    log.debug(
      `DVT handshake complete. Found ${Object.keys(this.supportedIdentifiers).length} supported identifiers`,
    );

    // Consume any additional messages buffered after handshake
    await this.drainBufferedMessages();
  }

  /**
   * Drain any buffered messages that arrived during handshake
   */
  private async drainBufferedMessages(): Promise<void> {
    if (this.readBuffer.length === 0) {
      return;
    }

    try {
      while (this.readBuffer.length >= DTX_CONSTANTS.MESSAGE_HEADER_SIZE) {
        const headerData = this.readBuffer.subarray(0, DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
        const header = DTXMessage.parseMessageHeader(headerData);

        const totalSize = DTX_CONSTANTS.MESSAGE_HEADER_SIZE + header.length;
        if (this.readBuffer.length >= totalSize) {
          // Consume complete buffered message
          this.readBuffer = this.readBuffer.subarray(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
          this.readBuffer = this.readBuffer.subarray(header.length);
        } else {
          break;
        }
      }
    } catch (error) {
      log.debug('Error while draining buffer:', error);
    }
  }

  /**
   * Get supported service identifiers (capabilities)
   */
  getSupportedIdentifiers(): PlistDictionary {
    return this.supportedIdentifiers;
  }

  /**
   * Create a communication channel for a specific service identifier
   * @param identifier The service identifier (e.g., 'com.apple.instruments.server.services.LocationSimulation')
   * @returns The created channel instance
   */
  async makeChannel(identifier: string): Promise<Channel> {
    if (!this.isHandshakeComplete) {
      throw new Error('Handshake not complete. Call connect() first.');
    }

    if (this.channelCache.has(identifier)) {
      return this.channelCache.get(identifier)!;
    }

    this.lastChannelCode++;
    const channelCode = this.lastChannelCode;

    const args = new MessageAux();
    args.appendInt(channelCode);
    args.appendObj(identifier);

    await this.sendMessage(0, '_requestChannelWithCode:identifier:', args);

    const [ret, _aux] = await this.recvPlist();

    // Check for NSError response
    if (ret && typeof ret === 'object' && '$objects' in ret) {
      const objects = (ret as any).$objects;
      if (Array.isArray(objects) && objects.length > 1) {
        // Check if response is effectively null/empty
        const isNullResponse =
          objects.length <= 1 || objects.every((o: any) => o === '$null' || o === null);

        if (!isNullResponse) {
          // Check for error indicators
          const hasError = objects.some(
            (o: any) =>
              typeof o === 'object' &&
              o !== null &&
              ('NSLocalizedDescription' in o || 'NSUserInfo' in o),
          );
          if (hasError) {
            const errorMsg =
              objects.find((o: any) => typeof o === 'string' && o.includes('Unable to invoke')) ||
              'Unknown error';
            throw new Error(`Failed to create channel: ${errorMsg}`);
          }
        }
      }
    } else if (ret && typeof ret === 'object' && ('NSLocalizedDescription' in ret || 'NSUserInfo' in ret)) {
      throw new Error(`Failed to create channel: ${JSON.stringify(ret)}`);
    }

    const channel = new Channel(channelCode, this);
    this.channelCache.set(identifier, channel);
    this.channelMessages.set(channelCode, new ChannelFragmenter());

    return channel;
  }

  /**
   * Send a DTX message on a channel
   * @param channel The channel code
   * @param selector The ObjectiveC method selector
   * @param args Optional message arguments
   * @param expectsReply Whether a reply is expected
   */
  async sendMessage(
    channel: number,
    selector: string | null = null,
    args: MessageAux | null = null,
    expectsReply: boolean = true,
  ): Promise<void> {
    if (!this.socket) {
      throw new Error('Not connected to DVT service');
    }

    this.curMessageId++;

    const auxBuffer = args ? this.buildAuxiliaryData(args) : Buffer.alloc(0);
    const selectorBuffer = selector ? this.archiveSelector(selector) : Buffer.alloc(0);

    let flags = DTX_CONSTANTS.INSTRUMENTS_MESSAGE_TYPE;
    if (expectsReply) {
      flags |= DTX_CONSTANTS.EXPECTS_REPLY_MASK;
    }

    const payloadHeader = DTXMessage.buildPayloadHeader({
      flags,
      auxiliaryLength: auxBuffer.length,
      totalLength: BigInt(auxBuffer.length + selectorBuffer.length),
    });

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

    const message = Buffer.concat([messageHeader, payloadHeader, auxBuffer, selectorBuffer]);

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(message, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receive a plist message from a channel
   * @param channel The channel to receive from
   * @returns Tuple of [decoded data, auxiliary values]
   */
  async recvPlist(
    channel: number = DVTSecureSocketProxyService.BROADCAST_CHANNEL,
  ): Promise<[any, any[]]> {
    const [data, aux] = await this.recvMessage(channel);

    let decodedData = null;
    if (data && data.length > 0) {
      try {
        decodedData = parseBinaryPlist(data);
      } catch (error) {
        log.warn('Failed to parse plist data:', error);
      }
    }

    return [decodedData, aux];
  }

  /**
   * Receive a raw message from a channel
   * @param channel The channel to receive from
   * @returns Tuple of [raw data, auxiliary values]
   */
  async recvMessage(
    channel: number = DVTSecureSocketProxyService.BROADCAST_CHANNEL,
  ): Promise<[Buffer | null, any[]]> {
    const packetData = await this.recvPacketFragments(channel);

    const payloadHeader = DTXMessage.parsePayloadHeader(packetData);

    const compression = (payloadHeader.flags & 0xff000) >> 12;
    if (compression) {
      throw new Error('Compressed messages not supported');
    }

    let offset = DTX_CONSTANTS.PAYLOAD_HEADER_SIZE;

    // Parse auxiliary data if present
    let aux: any[] = [];
    if (payloadHeader.auxiliaryLength > 0) {
      const auxBuffer = packetData.subarray(offset, offset + payloadHeader.auxiliaryLength);
      aux = this.parseAuxiliaryData(auxBuffer);
      offset += payloadHeader.auxiliaryLength;
    }

    // Extract object data
    const objSize = Number(payloadHeader.totalLength) - payloadHeader.auxiliaryLength;
    const data = objSize > 0 ? packetData.subarray(offset, offset + objSize) : null;

    return [data, aux];
  }

  /**
   * Receive packet fragments until a complete message is available for the specified channel
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
        return message;
      }

      // Read next message header
      const headerData = await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
      const header = DTXMessage.parseMessageHeader(headerData);

      const receivedChannel = Math.abs(header.channelCode);

      if (!this.channelMessages.has(receivedChannel)) {
        this.channelMessages.set(receivedChannel, new ChannelFragmenter());
      }

      // Update message ID tracker
      if (!header.conversationIndex && header.identifier > this.curMessageId) {
        this.curMessageId = header.identifier;
      }

      // Skip first fragment header for multi-fragment messages
      if (header.fragmentCount > 1 && header.fragmentId === 0) {
        continue;
      }

      // Read message payload
      const messageData = await this.readExact(header.length);

      // Add fragment to appropriate channel
      const targetFragmenter = this.channelMessages.get(receivedChannel)!;
      targetFragmenter.addFragment(header, messageData);
    }
  }

  /**
   * Read exact number of bytes from socket with buffering
   */
  private async readExact(length: number): Promise<Buffer> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

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
    }

    // Extract exact amount requested
    const result = this.readBuffer.subarray(0, length);
    this.readBuffer = this.readBuffer.subarray(length);

    return result;
  }

  /**
   * Archive a value using NSKeyedArchiver format for DTX protocol
   */
  private archiveValue(value: any): Buffer {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      // Simple values: wrap in NSKeyedArchiver structure
      const archived = {
        '$version': 100000,
        '$archiver': 'NSKeyedArchiver',
        '$top': { root: new PlistUID(1) },
        '$objects': ['$null', value],
      };
      return createBinaryPlist(archived);
    }

    // Complex objects: wrap in NSKeyedArchiver structure
    const archived = {
      '$version': 100000,
      '$archiver': 'NSKeyedArchiver',
      '$top': { root: new PlistUID(1) },
      '$objects': ['$null', value],
    };

    return createBinaryPlist(archived);
  }

  /**
   * Archive a selector string for DTX messages
   */
  private archiveSelector(selector: string): Buffer {
    return this.archiveValue(selector);
  }

  /**
   * Build auxiliary data buffer with NSKeyedArchiver encoding for objects
   */
  private buildAuxiliaryData(args: MessageAux): Buffer {
    const values = args.getValues();

    if (values.length === 0) {
      return Buffer.alloc(0);
    }

    const itemBuffers: Buffer[] = [];

    for (const auxValue of values) {
      // Empty dictionary marker
      const dictMarker = Buffer.alloc(4);
      dictMarker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
      itemBuffers.push(dictMarker);

      // Type marker
      const typeBuffer = Buffer.alloc(4);
      typeBuffer.writeUInt32LE(auxValue.type, 0);
      itemBuffers.push(typeBuffer);

      // Value data
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
          const encodedPlist = this.archiveValue(auxValue.value);
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

    const itemsData = Buffer.concat(itemBuffers);

    // Build header: magic + total size of items
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
    header.writeBigUInt64LE(BigInt(itemsData.length), 8);

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
      let offset = 0;
      const values: any[] = [];

      // Read magic
      const magic = buffer.readBigUInt64LE(offset);
      if (magic !== BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC)) {
        // Auxiliary data might be in NSKeyedArchiver bplist format
        // Search for bplist header
        const hexStr = buffer.toString('ascii', 0, Math.min(100, buffer.length));
        const bplistOffset = hexStr.indexOf('bplist00');

        if (bplistOffset >= 0) {
          const plistBuffer = buffer.subarray(bplistOffset);
          const auxPlist = parseBinaryPlist(plistBuffer);

          if (Array.isArray(auxPlist)) {
            return auxPlist;
          }
          return [auxPlist];
        }
        return [];
      }
      offset += 8;

      // Read total size of auxiliary items
      const totalSize = Number(buffer.readBigUInt64LE(offset));
      offset += 8;

      const endOffset = offset + totalSize;

      // Parse each auxiliary item
      while (offset < endOffset) {
        // Skip empty dictionary marker
        const emptyDict = buffer.readUInt32LE(offset);
        offset += 4;

        if (emptyDict !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
          offset -= 4;
        }

        // Read type
        const type = buffer.readUInt32LE(offset);
        offset += 4;

        // Read value
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
            const length = buffer.readUInt32LE(offset);
            offset += 4;

            const plistData = buffer.subarray(offset, offset + length);
            offset += length;

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

    // Send channel cancellation for all active channels
    const activeCodes = Array.from(this.channelMessages.keys()).filter((code) => code > 0);

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
          false,
        );
      } catch (error) {
        log.debug('Error sending channel canceled message:', error);
      }
    }

    this.connection.close();
    this.connection = null;
    this.socket = null;
    this.isHandshakeComplete = false;
    this.channelCache.clear();
    this.channelMessages.clear();
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());
  }
}

export { Channel, ChannelFragmenter, DTXMessage, MessageAux, DTX_CONSTANTS };
export type { DTXMessageHeader, DTXMessagePayloadHeader, MessageAuxValue } from './dtx-message.js';
