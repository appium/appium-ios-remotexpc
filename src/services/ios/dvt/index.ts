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
    const [retData, aux] = await this.recvMessage();
    
    log.debug(`Received handshake selector (raw ${retData?.length} bytes): ${retData?.toString('hex')}`);
    
    // Parse the selector
    const ret = retData ? parseBinaryPlist(retData) : null;
    
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
    // It's an NSKeyedArchiver structure, extract the actual dictionary
    const capabilities = aux[0];
    
    if (capabilities && typeof capabilities === 'object' && '$objects' in capabilities) {
      // NSKeyedArchiver format - extract the dictionary from $objects
      const objects = capabilities.$objects;
      
      if (Array.isArray(objects) && objects.length > 1) {
        const dictObj = objects[1]; // Index 1 should contain the dictionary structure
        
        if (dictObj && typeof dictObj === 'object' && 'NS.keys' in dictObj && 'NS.objects' in dictObj) {
          // NSDictionary format with NS.keys and NS.objects references
          const keysRef = dictObj['NS.keys'];
          const valuesRef = dictObj['NS.objects'];
          
          // The keys and values are arrays of indices into the $objects array
          if (Array.isArray(keysRef) && Array.isArray(valuesRef)) {
            this.supportedIdentifiers = {};
            for (let i = 0; i < keysRef.length; i++) {
              const keyIdx = keysRef[i];
              const valueIdx = valuesRef[i];
              const key = objects[keyIdx];
              const value = objects[valueIdx];
              if (typeof key === 'string') {
                this.supportedIdentifiers[key] = value;
              }
            }
          }
        } else {
          // The $objects array contains the capability strings directly
          // Build a dictionary where each string is a key with value true
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
    
    log.debug(`DVT handshake complete. Found ${Object.keys(this.supportedIdentifiers).length} supported identifiers`);
    
    // The server may send additional notification messages after the handshake
    // These are typically on channel 0 with server-generated message IDs
    // We need to consume and discard them
    if (this.readBuffer.length > 0) {
      log.debug(`Read buffer has ${this.readBuffer.length} bytes - checking for additional handshake messages`);
      
      // Try to read and discard any pending messages on channel 0
      try {
        while (this.readBuffer.length >= DTX_CONSTANTS.MESSAGE_HEADER_SIZE) {
          const headerPeek = this.readBuffer.subarray(0, DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
          const headerCheck = DTXMessage.parseMessageHeader(headerPeek);
          
          const totalSize = DTX_CONSTANTS.MESSAGE_HEADER_SIZE + headerCheck.length;
          if (this.readBuffer.length >= totalSize) {
            // Complete message in buffer - consume and log it
            log.debug(`Consuming buffered message ID ${headerCheck.identifier} on channel ${headerCheck.channelCode}`);
            await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE); // Read header
            await this.readExact(headerCheck.length); // Read and discard data
            log.debug(`Discarded server message ID ${headerCheck.identifier}`);
          } else {
            break;
          }
        }
      } catch (error) {
        log.debug('Error while draining buffer:', error);
      }
      
      log.debug(`After draining, ${this.readBuffer.length} bytes remain`);
    }
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

    log.debug(`Creating channel with code ${channelCode} for identifier: ${identifier}`);
    
    await this.sendMessage(0, '_requestChannelWithCode:identifier:', args);
    
    const [ret, _aux] = await this.recvPlist();
    
    log.debug(`Channel creation response:`, { ret, retType: typeof ret });
    
    // The response might be null or an empty object/plist
    // Check if it's an error (NSError has specific structure)
    if (ret && typeof ret === 'object') {
      // Check if it's an NSKeyedArchiver structure that's actually null/empty
      if ('$objects' in ret) {
        const objects = (ret as any).$objects;
        // If objects array only has '$null', it's effectively null
        if (!Array.isArray(objects) || objects.length <= 1 || objects.every((o: any) => o === '$null' || o === null)) {
          // This is fine, treat as null
          log.debug('Channel creation response is effectively null (empty NSKeyedArchiver)');
        } else {
          // Check if it's an NSError
          const hasError = objects.some((o: any) => 
            typeof o === 'object' && o !== null && ('NSLocalizedDescription' in o || 'NSUserInfo' in o)
          );
          if (hasError) {
            throw new Error(`Failed to create channel: ${JSON.stringify(ret)}`);
          }
          log.debug('Channel creation response has data but not an error');
        }
      } else if ('NSLocalizedDescription' in ret || 'NSUserInfo' in ret) {
        // Direct NSError structure
        throw new Error(`Failed to create channel: ${JSON.stringify(ret)}`);
      }
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

    // Encode selector - Python uses archiver.archive() which creates specific NSKeyedArchiver format
    // For now, use the Python-generated hex as a template-based encoder
    const selectorBuffer = selector ? this.archiveSelectorPython(selector) : Buffer.alloc(0);
    
    if (selector) {
      log.debug(`Encoded selector "${selector}" to ${selectorBuffer.length} bytes`);
      log.debug(`Selector buffer (full): ${selectorBuffer.toString('hex')}`);
    }

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
    
    // Debug: show the complete message structure
    if (log.level === 'debug' && selector) {
      log.debug(`Message header (32 bytes): ${messageHeader.toString('hex')}`);
      log.debug(`Payload header (16 bytes): ${payloadHeader.toString('hex')}`);
      log.debug(`Aux buffer (${auxBuffer.length} bytes, first 64): ${auxBuffer.subarray(0, Math.min(64, auxBuffer.length)).toString('hex')}`);
      log.debug(`Selector buffer (${selectorBuffer.length} bytes): ${selectorBuffer.toString('hex')}`);
    }
    
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
    log.debug(`recvPacketFragments: waiting for message on channel ${channel}, current message ID: ${this.curMessageId}`);
    
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
      log.debug(`Reading message header (expecting for channel ${channel})`);
      const headerData = await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
      const header = DTXMessage.parseMessageHeader(headerData);
      
      log.debug(`Received message header:`, {
        channelCode: header.channelCode,
        identifier: header.identifier,
        conversationIndex: header.conversationIndex,
        fragmentId: header.fragmentId,
        fragmentCount: header.fragmentCount,
        length: header.length,
        expectsReply: header.expectsReply,
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
      log.debug(`Reading message data of length ${header.length} for channel ${receivedChannel}`);
      const messageData = await this.readExact(header.length);
      
      // Add fragment to appropriate channel
      const targetFragmenter = this.channelMessages.get(receivedChannel)!;
      targetFragmenter.addFragment(header, messageData);
      
      log.debug(`Added fragment to channel ${receivedChannel}, fragmenter now has ${targetFragmenter.getMessageCount()} messages`);
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
   * Archive a selector using Python's bpylist2.archiver format
   * Since we can't exactly replicate Python's archiver.archive() due to UID encoding differences,
   * we'll use the raw hex template from Python and substitute the selector string
   */
  private archiveSelectorPython(selector: string | number | boolean): Buffer {
    // Python's archiver.archive() produces a specific binary format
    // We need to match this exactly. The safest approach is to manually construct the NSKeyedArchiver structure
    
    // For non-string values, just wrap them
    if (typeof selector !== 'string') {
      const archived = {
        '$version': 100000,
        '$archiver': 'NSKeyedArchiver',
        '$top': { 'root': new PlistUID(1) },
        '$objects': ['$null', selector],
      };
      return createBinaryPlist(archived);
    }
    
    // Build NSKeyedArchiver binary plist manually to match Python's format
    // Based on the Python output, the structure has a specific layout with UIDs
    
    // For now, let's create a minimal NSKeyedArchiver structure
    // that should work with the server
    
    // Header
    const header = Buffer.from('bplist00', 'ascii');
    
    // Objects in the plist:
    // 0: dictionary (the root NSKeyedArchiver dict)
    // 1: "$archiver" key
    // 2: "NSKeyedArchiver" value
    // 3: "$objects" key
    // 4: array of objects
    // 5: "$top" key
    // 6: "$version" key
    // 7: "$null" string
    // 8: the selector string
    // 9: dict for $top value
    // 10: "root" key
    // ... and UIDs
    
    // This is getting complex. Let me just use the simple NSKeyedArchiver structure
    // and hope our bplist encoder handles it correctly
    
    // Use UID for the root reference to match Python's archiver format
    const archived = {
      '$version': 100000,
      '$archiver': 'NSKeyedArchiver',
      '$top': { 'root': new PlistUID(1) },  // UID reference to object at index 1
      '$objects': ['$null', selector],
    };
    
    return createBinaryPlist(archived);
  }

  /**
   * Archive an object using NSKeyedArchiver format
   * This mimics Python's archiver.archive() function
   */
  private archiveObject(obj: any): Buffer {
    // For simple values (strings, numbers), use the selector archiver
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      return this.archiveSelectorPython(obj);
    }
    
    // For complex objects (dictionaries, arrays), use the same structure
    // but with the object as the root
    const archived = {
      '$version': 100000,
      '$archiver': 'NSKeyedArchiver',
      '$top': { 'root': new PlistUID(1) },
      '$objects': ['$null', obj],
    };
    
    return createBinaryPlist(archived);
  }

  /**
   * Archive a selector using NSKeyedArchiver format
   */
  private archiveSelector(selector: string): Buffer {
    return this.archiveSelectorPython(selector);
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

    log.debug(`Building auxiliary data with ${values.length} values`);

    // First, build all the auxiliary items
    const itemBuffers: Buffer[] = [];
    
    // Write each auxiliary value
    for (let idx = 0; idx < values.length; idx++) {
      const auxValue = values[idx];
      log.debug(`Aux value ${idx}: type=${auxValue.type}, value type=${typeof auxValue.value}`);
      
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
          log.debug(`  Encoded INT32: ${auxValue.value}`);
          break;
        }
        
        case DTX_CONSTANTS.AUX_TYPE_INT64: {
          const valueBuffer = Buffer.alloc(8);
          valueBuffer.writeBigUInt64LE(BigInt(auxValue.value), 0);
          itemBuffers.push(valueBuffer);
          log.debug(`  Encoded INT64: ${auxValue.value}`);
          break;
        }
        
        case DTX_CONSTANTS.AUX_TYPE_OBJECT: {
          // Encode object using NSKeyedArchiver format
          log.debug(`  Encoding object as NSKeyedArchiver:`, JSON.stringify(auxValue.value).substring(0, 100));
          const encodedPlist = this.archiveObject(auxValue.value);
          log.debug(`  Encoded plist size: ${encodedPlist.length} bytes`);
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
    
    log.debug(`Total auxiliary data size: ${header.length + itemsData.length} bytes (header: 16, items: ${itemsData.length})`);
    
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
