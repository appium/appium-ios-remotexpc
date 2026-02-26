import net from 'node:net';

import { getLogger } from '../../../lib/logger.js';
import {
  createBinaryPlist,
  parseBinaryPlist,
} from '../../../lib/plist/index.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService, type Service } from '../base-service.js';
import { ChannelFragmenter } from '../dvt/channel-fragmenter.js';
import { Channel } from '../dvt/channel.js';
import { DTXMessage, DTX_CONSTANTS, MessageAux } from '../dvt/dtx-message.js';
import { decodeNSKeyedArchiver } from '../dvt/nskeyedarchiver-decoder.js';
import { NSKeyedArchiverEncoder } from '../dvt/nskeyedarchiver-encoder.js';
import {
  extractCapabilityStrings,
  extractNSDictionary,
  extractNSKeyedArchiverObjects,
  hasNSErrorIndicators,
  isNSDictionaryFormat,
} from '../dvt/utils.js';

const log = getLogger('DvtTestmanagedProxyService');

const MIN_ERROR_DESCRIPTION_LENGTH = 20;

/**
 * DvtTestmanagedProxyService provides access to Apple's testmanagerd functionality
 * over the DTX binary protocol. This service enables XCTest session management
 * for running tests without xcodebuild.
 *
 * It uses the same DTX protocol as DVTSecureSocketProxyService but connects
 * to a different RSD service (com.apple.dt.testmanagerd.remote).
 */
export class DvtTestmanagedProxyService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.dt.testmanagerd.remote';
  static readonly BROADCAST_CHANNEL = 0;

  private connection: ServiceConnection | null = null;
  private socket: net.Socket | null = null;
  private supportedIdentifiers: PlistDictionary = {};
  private lastChannelCode: number = 0;
  private curMessageId: number = 0;
  private lastReceivedMessageId: number = 0;
  private readonly channelCache: Map<string, Channel> = new Map();
  private readonly channelMessages: Map<number, ChannelFragmenter> = new Map();
  private isHandshakeComplete: boolean = false;
  private readBuffer: Buffer = Buffer.alloc(0);

  constructor(address: [string, number]) {
    super(address);
    this.channelMessages.set(
      DvtTestmanagedProxyService.BROADCAST_CHANNEL,
      new ChannelFragmenter(),
    );
  }

  /**
   * Connect to the testmanagerd service and perform DTX handshake
   */
  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    const service: Service = {
      serviceName: DvtTestmanagedProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    // testmanagerd uses DTX binary protocol, connect without plist-based RSDCheckin
    this.connection = await this.startLockdownWithoutCheckin(service);
    this.socket = this.connection.getSocket();

    // Remove SSL context if present for raw DTX communication
    if ('_sslobj' in this.socket) {
      (this.socket as any)._sslobj = null;
    }

    await this.performHandshake();
  }

  /**
   * Get supported service identifiers (capabilities)
   */
  getSupportedIdentifiers(): PlistDictionary {
    return this.supportedIdentifiers;
  }

  /**
   * Create a communication channel for a specific service identifier
   * @param identifier The channel identifier (e.g., 'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface')
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

    const [ret] = await this.recvPlist();

    // Check for NSError in response
    this.checkForNSError(ret, 'Failed to create channel');

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
      throw new Error('Not connected to testmanagerd service');
    }

    this.curMessageId++;

    const auxBuffer = args ? this.buildAuxiliaryData(args) : Buffer.alloc(0);
    const selectorBuffer = selector
      ? this.archiveSelector(selector)
      : Buffer.alloc(0);

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
      length:
        DTX_CONSTANTS.PAYLOAD_HEADER_SIZE +
        auxBuffer.length +
        selectorBuffer.length,
      identifier: this.curMessageId,
      conversationIndex: 0,
      channelCode: channel,
      expectsReply: expectsReply ? 1 : 0,
    });

    const message = Buffer.concat([
      messageHeader,
      payloadHeader,
      auxBuffer,
      selectorBuffer,
    ]);

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
   * Send a DTX reply message for the last received message on a channel.
   * Used for responding to callbacks like _XCT_testRunnerReadyWithCapabilities:.
   *
   * @param channel The channel code
   * @param payload Optional archived payload to include in the reply
   */
  async sendReply(
    channel: number,
    payload: Buffer | null = null,
  ): Promise<void> {
    if (!this.socket) {
      throw new Error('Not connected to testmanagerd service');
    }

    const payloadBuffer = payload ?? Buffer.alloc(0);

    const payloadHeader = DTXMessage.buildPayloadHeader({
      flags: DTX_CONSTANTS.REPLY_TYPE,
      auxiliaryLength: 0,
      totalLength: BigInt(payloadBuffer.length),
    });

    const messageHeader = DTXMessage.buildMessageHeader({
      magic: DTX_CONSTANTS.MESSAGE_HEADER_MAGIC,
      cb: DTX_CONSTANTS.MESSAGE_HEADER_SIZE,
      fragmentId: 0,
      fragmentCount: 1,
      length: DTX_CONSTANTS.PAYLOAD_HEADER_SIZE + payloadBuffer.length,
      identifier: this.lastReceivedMessageId,
      conversationIndex: 1,
      channelCode: channel,
      expectsReply: 0,
    });

    const message = Buffer.concat([
      messageHeader,
      payloadHeader,
      payloadBuffer,
    ]);

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
   * @param signal Optional AbortSignal for cancellation
   * @returns Tuple of [decoded data, auxiliary values]
   */
  async recvPlist(
    channel: number = DvtTestmanagedProxyService.BROADCAST_CHANNEL,
    signal?: AbortSignal,
  ): Promise<[any, any[]]> {
    const [data, aux] = await this.recvMessage(channel, signal);

    let decodedData = null;
    if (data?.length) {
      try {
        decodedData = parseBinaryPlist(data);
        decodedData = decodeNSKeyedArchiver(decodedData);
      } catch (error) {
        log.debug('Failed to parse plist data:', error);
      }
    }

    return [decodedData, aux];
  }

  /**
   * Receive a plist message with a timeout. Returns null on timeout instead of
   * throwing, and properly cleans up socket listeners to prevent leaks.
   * @param channel The channel to receive from
   * @param timeoutMs Timeout in milliseconds
   * @returns Tuple of [decoded data, auxiliary values], or null on timeout
   */
  async recvPlistWithTimeout(
    channel: number = DvtTestmanagedProxyService.BROADCAST_CHANNEL,
    timeoutMs: number = 2000,
  ): Promise<[any, any[]] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.recvPlist(channel, controller.signal);
    } catch (err: any) {
      if (controller.signal.aborted) {
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Receive a raw message from a channel
   * @param channel The channel to receive from
   * @param signal Optional AbortSignal for cancellation
   * @returns Tuple of [raw data, auxiliary values]
   */
  async recvMessage(
    channel: number = DvtTestmanagedProxyService.BROADCAST_CHANNEL,
    signal?: AbortSignal,
  ): Promise<[Buffer | null, any[]]> {
    const packetData = await this.recvPacketFragments(channel, signal);

    const payloadHeader = DTXMessage.parsePayloadHeader(packetData);

    const compression = (payloadHeader.flags & 0xff000) >> 12;
    if (compression) {
      log.debug(
        `Skipping compressed DTX message (type=${compression}, flags=0x${payloadHeader.flags.toString(16)}, size=${payloadHeader.totalLength})`,
      );
      return [null, []];
    }

    let offset = DTX_CONSTANTS.PAYLOAD_HEADER_SIZE;

    let aux: any[] = [];
    if (payloadHeader.auxiliaryLength > 0) {
      const auxBuffer = packetData.subarray(
        offset,
        offset + payloadHeader.auxiliaryLength,
      );
      aux = this.parseAuxiliaryData(auxBuffer);
      offset += payloadHeader.auxiliaryLength;
    }

    const objSize =
      Number(payloadHeader.totalLength) - payloadHeader.auxiliaryLength;
    const data =
      objSize > 0 ? packetData.subarray(offset, offset + objSize) : null;

    return [data, aux];
  }

  /**
   * Close the testmanagerd service connection
   */
  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    const activeCodes = Array.from(this.channelMessages.keys()).filter(
      (code) => code > 0,
    );

    if (activeCodes.length > 0) {
      const args = new MessageAux();
      for (const code of activeCodes) {
        args.appendInt(code);
      }

      try {
        await this.sendMessage(
          DvtTestmanagedProxyService.BROADCAST_CHANNEL,
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
    this.channelMessages.set(
      DvtTestmanagedProxyService.BROADCAST_CHANNEL,
      new ChannelFragmenter(),
    );
  }

  private async performHandshake(): Promise<void> {
    const args = new MessageAux();
    args.appendObj({
      'com.apple.private.DTXBlockCompression': 0,
      'com.apple.private.DTXConnection': 1,
    });
    await this.sendMessage(0, '_notifyOfPublishedCapabilities:', args, false);

    const [retData, aux] = await this.recvMessage();
    const ret = retData ? parseBinaryPlist(retData) : null;

    const selectorName = this.extractSelectorFromResponse(ret);
    if (selectorName !== '_notifyOfPublishedCapabilities:') {
      throw new Error(`Invalid handshake response selector: ${selectorName}`);
    }

    if (!aux || aux.length === 0) {
      throw new Error('Invalid handshake response: missing capabilities');
    }

    this.supportedIdentifiers = this.extractCapabilitiesFromAuxData(aux[0]);
    this.isHandshakeComplete = true;

    log.debug(
      `Testmanagerd handshake complete. Found ${Object.keys(this.supportedIdentifiers).length} supported identifiers`,
    );

    this.drainBufferedMessages();
  }

  private extractSelectorFromResponse(ret: any): string {
    if (typeof ret === 'string') {
      return ret;
    }
    const objects = extractNSKeyedArchiverObjects(ret);
    if (objects) {
      return objects[1];
    }

    throw new Error('Invalid handshake response');
  }

  private extractCapabilitiesFromAuxData(
    capabilitiesData: any,
  ): PlistDictionary {
    const objects = extractNSKeyedArchiverObjects(capabilitiesData);
    if (!objects) {
      return capabilitiesData || {};
    }

    const dictObj = objects[1];

    if (isNSDictionaryFormat(dictObj)) {
      return extractNSDictionary(dictObj, objects);
    }

    return extractCapabilityStrings(objects);
  }

  private drainBufferedMessages(): void {
    if (this.readBuffer.length === 0) {
      return;
    }

    try {
      while (this.readBuffer.length >= DTX_CONSTANTS.MESSAGE_HEADER_SIZE) {
        const headerData = this.readBuffer.subarray(
          0,
          DTX_CONSTANTS.MESSAGE_HEADER_SIZE,
        );
        const header = DTXMessage.parseMessageHeader(headerData);

        const totalSize = DTX_CONSTANTS.MESSAGE_HEADER_SIZE + header.length;
        if (this.readBuffer.length >= totalSize) {
          this.readBuffer = this.readBuffer.subarray(totalSize);
        } else {
          break;
        }
      }
    } catch (error) {
      log.debug('Error while draining buffer:', error);
    }
  }

  private async recvPacketFragments(
    channel: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    while (true) {
      const fragmenter = this.channelMessages.get(channel);
      if (!fragmenter) {
        throw new Error(`No fragmenter for channel ${channel}`);
      }

      const message = fragmenter.get();
      if (message) {
        return message;
      }

      const headerData = await this.readExact(
        DTX_CONSTANTS.MESSAGE_HEADER_SIZE,
        signal,
      );
      const header = DTXMessage.parseMessageHeader(headerData);

      const receivedChannel = Math.abs(header.channelCode);

      if (!this.channelMessages.has(receivedChannel)) {
        this.channelMessages.set(receivedChannel, new ChannelFragmenter());
      }

      if (!header.conversationIndex && header.identifier > this.curMessageId) {
        this.curMessageId = header.identifier;
      }
      this.lastReceivedMessageId = header.identifier;

      if (header.fragmentCount > 1 && header.fragmentId === 0) {
        continue;
      }

      const messageData = await this.readExact(header.length, signal);

      const targetFragmenter = this.channelMessages.get(receivedChannel)!;
      targetFragmenter.addFragment(header, messageData);
    }
  }

  private async readExact(
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (!this.socket) {
      throw new Error(
        `${this.constructor.name} is not initialized. Call connect() before sending messages.`,
      );
    }

    while (this.readBuffer.length < length) {
      if (signal?.aborted) {
        throw new DOMException('Read aborted', 'AbortError');
      }

      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const cleanup = () => {
          this.socket?.off('data', onData);
          this.socket?.off('error', onError);
          this.socket?.off('close', onClose);
          signal?.removeEventListener('abort', onAbort);
        };

        const onData = (data: Buffer) => {
          cleanup();
          resolve(data);
        };

        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };

        const onClose = () => {
          cleanup();
          reject(new Error('Socket closed during read'));
        };

        const onAbort = () => {
          cleanup();
          reject(new DOMException('Read aborted', 'AbortError'));
        };

        // Register all listeners before any async gap to prevent data race
        this.socket!.once('data', onData);
        this.socket!.once('error', onError);
        this.socket!.once('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
      });

      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    }

    const result = this.readBuffer.subarray(0, length);
    this.readBuffer = this.readBuffer.subarray(length);

    return result;
  }

  private checkForNSError(response: any, context: string): void {
    if (!response || typeof response !== 'object') {
      return;
    }

    const objects = extractNSKeyedArchiverObjects(response);
    if (objects) {
      const hasNSError = objects.some((o) => hasNSErrorIndicators(o));

      if (hasNSError) {
        const errorMsg =
          objects.find(
            (o: any) =>
              typeof o === 'string' && o.length > MIN_ERROR_DESCRIPTION_LENGTH,
          ) || 'Unknown error';
        throw new Error(`${context}: ${errorMsg}`);
      }
    }

    if (hasNSErrorIndicators(response)) {
      throw new Error(`${context}: ${JSON.stringify(response)}`);
    }
  }

  private archiveValue(value: any): Buffer {
    const encoder = new NSKeyedArchiverEncoder();
    const archived = encoder.encode(value);
    return createBinaryPlist(archived);
  }

  private archiveSelector(selector: string): Buffer {
    return this.archiveValue(selector);
  }

  private buildAuxiliaryData(args: MessageAux): Buffer {
    const values = args.getValues();

    if (values.length === 0) {
      return Buffer.alloc(0);
    }

    const itemBuffers: Buffer[] = [];

    for (const auxValue of values) {
      const dictMarker = Buffer.alloc(4);
      dictMarker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
      itemBuffers.push(dictMarker);

      const typeBuffer = Buffer.alloc(4);
      typeBuffer.writeUInt32LE(auxValue.type, 0);
      itemBuffers.push(typeBuffer);

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

    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
    header.writeBigUInt64LE(BigInt(itemsData.length), 8);

    return Buffer.concat([header, itemsData]);
  }

  private parseAuxiliaryData(buffer: Buffer): any[] {
    if (buffer.length < 16) {
      return [];
    }

    const magic = buffer.readBigUInt64LE(0);

    if (magic === BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC)) {
      return this.parseAuxiliaryStandard(buffer);
    }

    // Alternate format used by go-ios / iOS 17+ testmanagerd callbacks:
    // The first 16 bytes are an AuxiliaryHeader (magic + length) that does
    // not match the standard MESSAGE_AUX_MAGIC. The remaining bytes are
    // DTX PrimitiveDictionary key-value pairs (see go-ios dtx.go).
    const result = this.parseAuxiliaryPrimitiveDictionary(buffer.subarray(16));
    if (result.length === 0) {
      log.debug(
        `Unknown auxiliary format (magic=0x${magic.toString(16)}, size=${buffer.length}), returning empty`,
      );
    }
    return result;
  }

  /**
   * Parse DTX PrimitiveDictionary key-value pairs (go-ios format).
   * Each entry is: [type:4][value...] where type determines the value format.
   * Keys are always null (type 0x0A), values follow immediately after.
   */
  private parseAuxiliaryPrimitiveDictionary(buffer: Buffer): any[] {
    const values: any[] = [];
    let offset = 0;

    while (offset + 4 <= buffer.length) {
      // Read key (always t_null = 0x0A in practice)
      const keyType = buffer.readUInt32LE(offset);
      offset += 4;

      if (keyType !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
        // Not a null key — unexpected, try to skip
        log.debug(
          `Unexpected key type 0x${keyType.toString(16)} at offset ${offset - 4}`,
        );
        break;
      }

      if (offset + 4 > buffer.length) {
        break;
      }

      // Read value
      try {
        const result = this.readPrimitiveDictEntry(buffer, offset);
        values.push(result.data);
        offset = result.newOffset;
      } catch (error) {
        log.debug(
          `Failed to parse PrimitiveDict entry at offset ${offset}:`,
          error,
        );
        break;
      }
    }

    return values;
  }

  /**
   * Read a single PrimitiveDictionary entry.
   * Types: 0x01=string, 0x02=bytearray, 0x03=uint32, 0x06=int64, 0x0A=null
   */
  private readPrimitiveDictEntry(
    buffer: Buffer,
    offset: number,
  ): { data: any; newOffset: number } {
    const type = buffer.readUInt32LE(offset);
    offset += 4;

    switch (type) {
      case 0x0a: // t_null
        return { data: null, newOffset: offset };

      case 0x03: // t_uint32
        return {
          data: buffer.readUInt32LE(offset),
          newOffset: offset + 4,
        };

      case 0x06: // t_int64
        return {
          data: Number(buffer.readBigUInt64LE(offset)),
          newOffset: offset + 8,
        };

      case 0x01: // t_string
      case 0x02: {
        // t_bytearray
        const length = buffer.readUInt32LE(offset);
        offset += 4;
        const data = buffer.subarray(offset, offset + length);

        if (type === 0x01) {
          return { data: data.toString('utf8'), newOffset: offset + length };
        }

        // For bytearrays, try to decode as NSKeyedArchiver plist
        let parsed: any = data;
        try {
          const plistData = parseBinaryPlist(data);
          parsed = decodeNSKeyedArchiver(plistData);
        } catch {
          // Not a plist, return raw buffer
        }
        return { data: parsed, newOffset: offset + length };
      }

      default:
        throw new Error(`Unknown PrimitiveDict type: 0x${type.toString(16)}`);
    }
  }

  private parseAuxiliaryStandard(buffer: Buffer): any[] {
    const values: any[] = [];
    let offset = 16;

    const totalSize = buffer.readBigUInt64LE(8);
    const endOffset = offset + Number(totalSize);

    while (offset < endOffset && offset < buffer.length) {
      const marker = buffer.readUInt32LE(offset);
      offset += 4;

      if (marker !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
        offset -= 4;
      }

      const type = buffer.readUInt32LE(offset);
      offset += 4;

      try {
        const value = this.parseAuxiliaryValue(buffer, type, offset);
        values.push(value.data);
        offset = value.newOffset;
      } catch (error) {
        log.debug(
          `Failed to parse auxiliary value at offset ${offset}:`,
          error,
        );
        break;
      }
    }

    return values;
  }

  private parseAuxiliaryValue(
    buffer: Buffer,
    type: number,
    offset: number,
  ): { data: any; newOffset: number } {
    switch (type) {
      case DTX_CONSTANTS.AUX_TYPE_INT32:
        return {
          data: buffer.readUInt32LE(offset),
          newOffset: offset + 4,
        };

      case DTX_CONSTANTS.AUX_TYPE_INT64:
        return {
          data: buffer.readBigUInt64LE(offset),
          newOffset: offset + 8,
        };

      case DTX_CONSTANTS.AUX_TYPE_OBJECT: {
        const length = buffer.readUInt32LE(offset);
        const plistData = buffer.subarray(offset + 4, offset + 4 + length);

        let parsed: any;
        try {
          parsed = parseBinaryPlist(plistData);
        } catch (error) {
          log.debug('Failed to parse auxiliary object plist:', error);
          parsed = plistData;
        }

        return {
          data: parsed,
          newOffset: offset + 4 + length,
        };
      }

      default:
        throw new Error(`Unknown auxiliary type: ${type}`);
    }
  }
}

export { Channel, ChannelFragmenter, DTXMessage, MessageAux, DTX_CONSTANTS };
