import type net from 'node:net';

import { getLogger } from '../../../lib/logger.js';
import {
  fatalizeAfcSocket,
  readAfcHeader,
  readExact,
  readUInt64LE,
  sendAfcPacket,
} from './codec.js';
import { AFC_HEADER_SIZE, AFC_OPERATION_TIMEOUT_MS } from './constants.js';
import { AfcError, AfcOpcode } from './enums.js';
import { AfcConnectionError } from './errors.js';

const log = getLogger('AfcService');

type PendingResponse = {
  resolve: (value: { status: AfcError; data: Buffer }) => void;
  reject: (err: Error) => void;
};

/**
 * Routes inbound AFC packets to the matching request by packet_num.
 * A background reader task demultiplexes responses so callers can overlap
 * sends while each operation is matched to its reply.
 */
export class AfcPacketDemux {
  private readonly pending = new Map<bigint, PendingResponse>();
  private packetNum = 0n;
  private readerTask: Promise<void> | null = null;
  private readerSocket: net.Socket | null = null;
  private readerActive = false;
  private sendLock: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly getSocket: () => Promise<net.Socket>,
    private readonly onFatalError: (err: Error) => void,
  ) {}

  ensureReaderStarted(socket: net.Socket): void {
    if (this.stopped) {
      throw new AfcConnectionError('AFC demux is stopped');
    }
    if (this.readerActive && this.readerSocket === socket) {
      return;
    }
    this.readerSocket = socket;
    this.readerActive = true;
    this.readerTask = this._readerLoop(socket)
      .catch((err) => {
        this._failPending(
          err instanceof Error ? err : new Error(String(err)),
          true,
        );
      })
      .finally(() => {
        this.readerActive = false;
      });
  }

  /**
   * Register a waiter, send one packet, then await its response.
   * packet_num assignment, waiter registration, and send are serialized;
   * awaiting the response happens outside the send lock.
   */
  async sendAndWait(
    op: AfcOpcode,
    headerPayload: Buffer = Buffer.alloc(0),
    content: Buffer = Buffer.alloc(0),
    timeoutMs = AFC_OPERATION_TIMEOUT_MS,
  ): Promise<{ status: AfcError; data: Buffer }> {
    if (this.stopped) {
      throw new AfcConnectionError('AFC demux is stopped');
    }

    const socket = await this.getSocket();
    this.ensureReaderStarted(socket);

    const responsePromise = await this._sendLocked(async () => {
      const num = this.packetNum++;
      const waiter = this._registerPending(num, timeoutMs, op);
      try {
        await sendAfcPacket(socket, op, num, headerPayload, content);
      } catch (err) {
        this._clearPending(num);
        throw err;
      }
      return waiter;
    });

    return await responsePromise;
  }

  resetForNewSocket(): void {
    this._failPending(new AfcConnectionError('AFC socket replaced'), false);
    this.readerTask = null;
    this.readerSocket = null;
    this.readerActive = false;
    this.stopped = false;
    this.sendLock = Promise.resolve();
  }

  /** Graceful shutdown; does not notify the owning service. */
  stop(): void {
    this.stopped = true;
    this._failPending(new AfcConnectionError('AFC demux stopped'), false);
    this.readerTask = null;
    this.readerSocket = null;
    this.readerActive = false;
  }

  private async _sendLocked<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.sendLock;
    this.sendLock = previous.then(() => turn);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private _registerPending(
    pktNum: bigint,
    timeoutMs: number,
    op: AfcOpcode,
  ): Promise<{ status: AfcError; data: Buffer }> {
    return new Promise<{ status: AfcError; data: Buffer }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this.pending.has(pktNum)) {
            return;
          }
          this._clearPending(pktNum);
          reject(
            new AfcConnectionError(
              `AFC operation ${AfcOpcode[op] ?? op} timed out after ${timeoutMs}ms (packet ${pktNum})`,
            ),
          );
        }, timeoutMs);

        this.pending.set(pktNum, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      },
    );
  }

  private _clearPending(pktNum: bigint): void {
    this.pending.delete(pktNum);
  }

  private async _readerLoop(socket: net.Socket): Promise<void> {
    try {
      while (!this.stopped && !socket.destroyed) {
        const header = await readAfcHeader(socket, AFC_OPERATION_TIMEOUT_MS);
        const payloadLen = Number(
          header.entireLength - BigInt(AFC_HEADER_SIZE),
        );
        const payload =
          payloadLen > 0
            ? await readExact(socket, payloadLen, AFC_OPERATION_TIMEOUT_MS)
            : Buffer.alloc(0);

        let status = AfcError.SUCCESS;
        let data = payload;
        const op = Number(header.operation) as AfcOpcode;

        if (op === AfcOpcode.STATUS) {
          if (payloadLen !== 8) {
            log.error(`AFC STATUS response length != 8 (${payloadLen})`);
          }
          status = Number(readUInt64LE(payload.subarray(0, 8))) as AfcError;
          data = Buffer.alloc(0);
        } else if (op !== AfcOpcode.DATA) {
          log.debug(
            `Unexpected AFC response opcode ${op} for packet ${header.packetNum}`,
          );
        }

        const waiter = this.pending.get(header.packetNum);
        if (waiter) {
          this.pending.delete(header.packetNum);
          waiter.resolve({ status, data });
        } else {
          log.warn(
            `AFC response with no waiter (packet ${header.packetNum}, op ${op})`,
          );
        }
      }
    } catch (err) {
      if (this.stopped) {
        return;
      }
      const error =
        err instanceof Error ? err : new AfcConnectionError(String(err));
      if (!socket.destroyed) {
        fatalizeAfcSocket(socket, error);
      }
      throw error;
    }
  }

  private _failPending(err: Error, notifyService: boolean): void {
    for (const [, waiter] of this.pending) {
      waiter.reject(err);
    }
    this.pending.clear();
    if (notifyService) {
      this.onFatalError(err);
    }
  }
}
