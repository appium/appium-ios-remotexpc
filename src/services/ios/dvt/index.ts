import type net from 'node:net';

import {getLogger} from '../../../lib/logger.js';
import {createBinaryPlist, parseBinaryPlist} from '../../../lib/plist/index.js';
import type {PlistDictionary, SendMessageOptions} from '../../../lib/types.js';
import {type ServiceConnection} from '../../../service-connection.js';
import {BaseService, stripSSL} from '../base-service.js';
import {ChannelFragmenter, type MessageFilter} from './channel-fragmenter.js';
import {Channel} from './channel.js';
import {DTXMessage, DTX_CONSTANTS, MessageAux} from './dtx-message.js';
import {decodeNSKeyedArchiver} from './nskeyedarchiver-decoder.js';
import {NSKeyedArchiverEncoder} from './nskeyedarchiver-encoder.js';
import {
  extractCapabilityStrings,
  extractNSDictionary,
  extractNSKeyedArchiverObjects,
  hasNSErrorIndicators,
  isNSDictionaryFormat,
} from './utils.js';

const log = getLogger('DVTSecureSocketProxyService');

const MIN_ERROR_DESCRIPTION_LENGTH = 20;

interface ChannelWaiter {
  resolve: (message: Buffer) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** When set, only messages whose header matches may satisfy this waiter. */
  filter?: MessageFilter;
}

/** Device-initiated callbacks arrive with conversation index 0; replies do not. */
const isReply: MessageFilter = (header) => header.conversationIndex > 0;

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
  private readonly channelCache: Map<string, Channel> = new Map();
  private readonly channelMessages: Map<number, ChannelFragmenter> = new Map();
  private readonly channelWaiters: Map<number, ChannelWaiter[]> = new Map();
  private isHandshakeComplete: boolean = false;
  private readBuffer: Buffer = Buffer.alloc(0);
  private readonly pendingChunks: Buffer[] = [];
  private bufferedLength: number = 0;
  private readonly dataWaiters: Array<() => void> = [];
  private socketError: Error | null = null;
  private isPumpRunning: boolean = false;
  private listeningSocket: net.Socket | null = null;
  private readonly boundOnData = (chunk: Buffer): void => this.onSocketData(chunk);
  private readonly boundOnError = (err: Error): void => this.onSocketError(err);
  private readonly boundOnClose = (): void => this.onSocketClose();

  constructor(udid: string) {
    super(udid);
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());
  }

  /**
   * Connect to the DVT service and perform handshake
   */
  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }

    // DVT uses DTX binary protocol, connect without plist-based RSDCheckin
    this.connection = await this.startLockdownWithoutCheckin(DVTSecureSocketProxyService.RSD_SERVICE_NAME);
    this.socket = this.connection.getSocket();
    stripSSL(this.socket);
    this.attachSocketListeners(this.socket);

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
   * @param identifier The service identifier (e.g., 'com.apple.instruments.server.services.LocationSimulation')
   * @returns The created channel instance
   */
  async makeChannel(identifier: string): Promise<Channel> {
    if (!this.isHandshakeComplete) {
      throw new Error('Handshake not complete. Call connect() first.');
    }

    const cachedChannel = this.channelCache.get(identifier);
    if (cachedChannel) {
      return cachedChannel;
    }

    this.lastChannelCode++;
    const channelCode = this.lastChannelCode;

    const args = new MessageAux();
    args.appendInt(channelCode);
    args.appendObj(identifier);

    await this.sendMessage(0, '_requestChannelWithCode:identifier:', {args});

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
   * @param options Optional message options
   */
  async sendMessage(channel: number, selector: string | null = null, options: SendMessageOptions = {}): Promise<void> {
    const {args = null, expectsReply = true} = options;
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
    const socket = this.socket;
    if (!socket) {
      throw new Error('Socket is not initialized');
    }

    await new Promise<void>((resolve, reject) => {
      socket.write(message, (err) => {
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
    signal?: AbortSignal,
  ): Promise<[any, any[]]> {
    return await this.recvPlistFiltered(channel, signal);
  }

  /**
   * Receive the reply to a request, skipping device-initiated callbacks. One
   * stray callback would otherwise shift every later read by one message.
   * Skipped callbacks stay queued for stream readers like
   * `ProcessControl.outputEvents()`.
   *
   * @param channel The channel to receive from
   * @param signal Optional AbortSignal for cancellation
   */
  async recvReplyPlist(
    channel: number = DVTSecureSocketProxyService.BROADCAST_CHANNEL,
    signal?: AbortSignal,
  ): Promise<[any, any[]]> {
    return await this.recvPlistFiltered(channel, signal, isReply);
  }

  private async recvPlistFiltered(
    channel: number,
    signal?: AbortSignal,
    filter?: MessageFilter,
  ): Promise<[any, any[]]> {
    const [data, aux] = await this.recvMessage(channel, signal, filter);

    let decodedData = null;
    if (data?.length) {
      try {
        decodedData = parseBinaryPlist(data);
        // decode NSKeyedArchiver format
        decodedData = decodeNSKeyedArchiver(decodedData);
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
    signal?: AbortSignal,
    filter?: MessageFilter,
  ): Promise<[Buffer | null, any[]]> {
    const packetData = await this.recvPacketFragments(channel, signal, filter);

    const payloadHeader = DTXMessage.parsePayloadHeader(packetData);

    const compression = (payloadHeader.flags & 0xff000) >> 12;

    if (compression !== 0) {
      throw new Error(`Unsupported DTX compression type: ${compression}`);
    }

    const payload = packetData.subarray(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE);

    let offset = 0;

    // Parse auxiliary data if present
    let aux: any[] = [];
    if (payloadHeader.auxiliaryLength > 0) {
      const auxBuffer = payload.subarray(0, payloadHeader.auxiliaryLength);
      aux = this.parseAuxiliaryData(auxBuffer);
      offset = payloadHeader.auxiliaryLength;
    }

    // Extract object data
    const objSize = Number(payloadHeader.totalLength) - payloadHeader.auxiliaryLength;
    const data = objSize > 0 ? payload.subarray(offset, offset + objSize) : null;

    return [data, aux];
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
        await this.sendMessage(DVTSecureSocketProxyService.BROADCAST_CHANNEL, '_channelCanceled:', {
          args,
          expectsReply: false,
        });
      } catch (error) {
        log.debug('Error sending channel canceled message:', error);
      }
    }

    const socketToDestroy = this.socket;
    this.detachSocketListeners();
    this.connection.close();
    this.connection = null;
    this.socket = null;
    this.isHandshakeComplete = false;
    this.socketError = null;
    this.channelCache.clear();
    this.channelMessages.clear();
    this.channelMessages.set(DVTSecureSocketProxyService.BROADCAST_CHANNEL, new ChannelFragmenter());
    this.readBuffer = Buffer.alloc(0);
    this.pendingChunks.length = 0;
    this.bufferedLength = 0;
    this.rejectAllWaiters(new Error('Service closed'));
    this.flushDataWaiters();

    socketToDestroy?.destroy();
  }

  private attachSocketListeners(socket: net.Socket): void {
    if (this.listeningSocket === socket) {
      return;
    }
    this.detachSocketListeners();
    this.listeningSocket = socket;
    socket.on('data', this.boundOnData);
    socket.on('error', this.boundOnError);
    socket.on('close', this.boundOnClose);
  }

  private detachSocketListeners(): void {
    if (!this.listeningSocket) {
      return;
    }
    this.listeningSocket.off('data', this.boundOnData);
    this.listeningSocket.off('error', this.boundOnError);
    this.listeningSocket.off('close', this.boundOnClose);
    this.listeningSocket = null;
  }

  private flushDataWaiters(): void {
    for (const waiter of this.dataWaiters.splice(0)) {
      waiter();
    }
  }

  private onSocketData(chunk: Buffer): void {
    this.pendingChunks.push(chunk);
    this.bufferedLength += chunk.length;
    if (this.dataWaiters.length > 0) {
      this.flushDataWaiters();
    } else {
      this.listeningSocket?.pause();
    }
  }

  private consolidateReadBuffer(): void {
    if (this.pendingChunks.length === 0) {
      return;
    }
    this.readBuffer = Buffer.concat([this.readBuffer, ...this.pendingChunks]);
    this.pendingChunks.length = 0;
  }

  private onSocketError(err: Error): void {
    if (!this.socketError) {
      this.socketError = err;
    }
    this.flushDataWaiters();
  }

  private onSocketClose(): void {
    if (!this.socketError) {
      this.socketError = new Error('Socket closed');
    }
    this.flushDataWaiters();
  }

  private rejectAllWaiters(error: Error): void {
    for (const waiters of this.channelWaiters.values()) {
      for (const waiter of waiters.splice(0)) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        waiter.reject(error);
      }
    }
    this.channelWaiters.clear();
  }

  private hasPendingWaiters(): boolean {
    return Array.from(this.channelWaiters.values()).some((waiters) => waiters.length > 0);
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
    await this.sendMessage(0, '_notifyOfPublishedCapabilities:', {
      args,
      expectsReply: false,
    });

    const [retData, aux] = await this.recvMessage();
    const ret = retData ? parseBinaryPlist(retData) : null;

    const selectorName = this.extractSelectorFromResponse(ret);
    if (selectorName !== '_notifyOfPublishedCapabilities:') {
      throw new Error(`Invalid handshake response selector: ${selectorName}`);
    }

    if (!aux || aux.length === 0) {
      throw new Error('Invalid handshake response: missing capabilities');
    }

    // Extract server capabilities from auxiliary data
    this.supportedIdentifiers = this.extractCapabilitiesFromAuxData(aux[0]);

    this.isHandshakeComplete = true;

    log.debug(`DVT handshake complete. Found ${Object.keys(this.supportedIdentifiers).length} supported identifiers`);

    // Consume any additional messages buffered after handshake
    await this.drainBufferedMessages();
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

  private extractCapabilitiesFromAuxData(capabilitiesData: any): PlistDictionary {
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

  /**
   * Drain any buffered messages that arrived during handshake
   */
  private async drainBufferedMessages(): Promise<void> {
    this.consolidateReadBuffer();
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
    this.bufferedLength = this.readBuffer.length;
  }

  /**
   * Receive packet fragments until a complete message is available for the specified channel
   */
  private async recvPacketFragments(channel: number, signal?: AbortSignal, filter?: MessageFilter): Promise<Buffer> {
    const fragmenter = this.channelMessages.get(channel);
    if (!fragmenter) {
      throw new Error(`No fragmenter for channel ${channel}`);
    }

    const queued = fragmenter.get(filter);
    if (queued) {
      return queued;
    }

    signal?.throwIfAborted();

    const promise = new Promise<Buffer>((resolve, reject) => {
      const waiter: ChannelWaiter = {resolve, reject, signal, filter};
      if (signal) {
        const onAbort = () => {
          const waiters = this.channelWaiters.get(channel);
          if (waiters) {
            const idx = waiters.indexOf(waiter);
            if (idx >= 0) {
              waiters.splice(idx, 1);
            }
          }
          reject(signal.reason ?? new DOMException('Receive aborted', 'AbortError'));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, {once: true});
      }

      const waiters = this.channelWaiters.get(channel) ?? [];
      this.channelWaiters.set(channel, waiters);
      waiters.push(waiter);
    });

    this.ensurePumpRunning();
    return promise;
  }

  private ensurePumpRunning(): void {
    if (this.isPumpRunning) {
      return;
    }
    this.isPumpRunning = true;
    void this.runPump()
      .catch((err: unknown) => {
        this.rejectAllWaiters(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.isPumpRunning = false;
        if (this.hasPendingWaiters()) {
          this.ensurePumpRunning();
        }
      });
  }

  private async runPump(): Promise<void> {
    while (this.hasPendingWaiters()) {
      const headerData = await this.readExact(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
      const header = DTXMessage.parseMessageHeader(headerData);

      if (header.magic !== DTX_CONSTANTS.MESSAGE_HEADER_MAGIC) {
        const err = new Error(
          `Invalid DTX message header magic: 0x${header.magic.toString(16)} (stream desynchronized)`,
        );
        this.socketError = err;
        throw err;
      }

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

      const messageData = await this.readExact(header.length);

      const targetFragmenter = this.channelMessages.get(receivedChannel);
      if (!targetFragmenter) {
        continue;
      }
      targetFragmenter.addFragment(header, messageData);

      this.deliverQueuedMessages(receivedChannel);
    }
  }

  /**
   * Hand queued messages to the waiters that accept them. A waiter matching
   * nothing stays pending so the pump keeps reading.
   */
  private deliverQueuedMessages(channel: number): void {
    const waiters = this.channelWaiters.get(channel);
    const fragmenter = this.channelMessages.get(channel);
    if (!waiters?.length || !fragmenter) {
      return;
    }

    let i = 0;
    while (i < waiters.length) {
      const waiter = waiters[i];
      const message = fragmenter.get(waiter.filter);
      if (!message) {
        i++;
        continue;
      }
      waiters.splice(i, 1);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(message);
    }
  }

  /**
   * Read exact number of bytes from socket with buffering
   */
  private async readExact(length: number): Promise<Buffer> {
    const socket = this.socket;
    if (!socket) {
      throw new Error(`${this.constructor.name} is not initialized. Call connect() before sending messages.`);
    }

    if (this.listeningSocket !== socket) {
      this.attachSocketListeners(socket);
    }

    while (this.bufferedLength < length) {
      if (this.socketError) {
        throw this.socketError;
      }
      if (this.socket !== socket || socket.destroyed) {
        throw new Error('Socket is destroyed');
      }

      socket.resume();
      await new Promise<void>((resolve) => {
        this.dataWaiters.push(resolve);
      });
    }

    this.consolidateReadBuffer();
    const result = this.readBuffer.subarray(0, length);
    this.readBuffer = this.readBuffer.subarray(length);
    this.bufferedLength = this.readBuffer.length;

    return result;
  }

  /**
   * Check if response contains an NSError and throw if present
   */
  private checkForNSError(response: any, context: string): void {
    if (!response || typeof response !== 'object') {
      return;
    }

    // Check NSKeyedArchiver format
    const objects = extractNSKeyedArchiverObjects(response);
    if (objects) {
      // Check for NSError indicators in $objects
      const hasNSError = objects.some((o) => hasNSErrorIndicators(o));

      if (hasNSError) {
        const errorMsg =
          objects.find((o: any) => typeof o === 'string' && o.length > MIN_ERROR_DESCRIPTION_LENGTH) || 'Unknown error';
        throw new Error(`${context}: ${errorMsg}`);
      }
    }

    // Check direct NSError format
    if (hasNSErrorIndicators(response)) {
      throw new Error(`${context}: ${JSON.stringify(response)}`);
    }
  }

  /**
   * Archive a value using NSKeyedArchiver format for DTX protocol
   */
  private archiveValue(value: any): Buffer {
    const encoder = new NSKeyedArchiverEncoder();
    const archived = encoder.encode(value);

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
   *
   * The auxiliary data format can be:
   * 1. Standard format: [magic:8][size:8][items...]
   * 2. NSKeyedArchiver bplist format (for handshake responses)
   */
  private parseAuxiliaryData(buffer: Buffer): any[] {
    if (buffer.length < 16) {
      return [];
    }

    const magic = buffer.readBigUInt64LE(0);

    // Check if this is NSKeyedArchiver bplist format (handshake response)
    if (magic !== BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC)) {
      return this.parseAuxiliaryAsBplist(buffer);
    }

    // Standard auxiliary format
    return this.parseAuxiliaryStandard(buffer);
  }

  /**
   * Parse auxiliary data in NSKeyedArchiver bplist format
   */
  private parseAuxiliaryAsBplist(buffer: Buffer): any[] {
    // Find bplist header in buffer
    const bplistMagic = 'bplist00';
    for (let i = 0; i < Math.min(100, buffer.length - 8); i++) {
      if (buffer.toString('ascii', i, i + 8) === bplistMagic) {
        try {
          const plistBuffer = buffer.subarray(i);
          const parsed = parseBinaryPlist(plistBuffer);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (error) {
          log.warn('Failed to parse auxiliary bplist:', error);
        }
        break;
      }
    }
    return [];
  }

  /**
   * Parse auxiliary data in standard DTX format
   */
  private parseAuxiliaryStandard(buffer: Buffer): any[] {
    const values: any[] = [];
    let offset = 16; // Skip magic (8) + size (8)

    const totalSize = buffer.readBigUInt64LE(8);
    const endOffset = offset + Number(totalSize);

    while (offset < endOffset && offset < buffer.length) {
      // Read and validate empty dictionary marker
      const marker = buffer.readUInt32LE(offset);
      offset += 4;

      if (marker !== DTX_CONSTANTS.EMPTY_DICTIONARY) {
        offset -= 4; // Rewind if not the expected marker
      }

      // Read type
      const type = buffer.readUInt32LE(offset);
      offset += 4;

      // Read value based on type
      try {
        const value = this.parseAuxiliaryValue(buffer, type, offset);
        values.push(value.data);
        offset = value.newOffset;
      } catch (error) {
        log.warn(`Failed to parse auxiliary value at offset ${offset}:`, error);
        break;
      }
    }

    return values;
  }

  /**
   * Parse a single auxiliary value
   */
  private parseAuxiliaryValue(buffer: Buffer, type: number, offset: number): {data: any; newOffset: number} {
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
          log.warn('Failed to parse auxiliary object plist:', error);
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

export {Channel, ChannelFragmenter, DTXMessage, MessageAux, DTX_CONSTANTS};
export {decodeNSKeyedArchiver, NSKeyedArchiverDecoder} from './nskeyedarchiver-decoder.js';
export type {DTXMessageHeader, DTXMessagePayloadHeader, MessageAuxValue} from './dtx-message.js';
