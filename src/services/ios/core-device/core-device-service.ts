import { randomUUID } from 'node:crypto';

import {
  Http2Constants,
  XpcConstants,
} from '../../../lib/remote-xpc/constants.js';
import { RemoteXpcFramedTransport } from '../../../lib/remote-xpc/remote-xpc-framed-transport.js';
import { encodeMessage } from '../../../lib/remote-xpc/xpc-protocol.js';
import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

/**
 * CoreDevice protocol version reported to the device.
 */
const CORE_DEVICE_VERSION_STRING = '629.3';
const CORE_DEVICE_DDI_PROTOCOL_VERSION = 2;

/**
 * Builds the `CoreDevice.coreDeviceVersion` dictionary. `components` are encoded
 * as XPC uint64 values (hence `bigint`), while `originalComponentsCount` is an
 * int64 (a plain integer).
 */
function buildCoreDeviceVersion(version: string): XPCDictionary {
  const components = version.split('.');
  return {
    components: components.map((component) => BigInt(component)),
    originalComponentsCount: components.length,
    stringValue: version,
  };
}

const CORE_DEVICE_VERSION = buildCoreDeviceVersion(CORE_DEVICE_VERSION_STRING);

/**
 * Error thrown when a CoreDevice invocation fails or returns no output.
 */
export class CoreDeviceError extends Error {
  readonly response?: XPCDictionary;

  constructor(message: string, response?: XPCDictionary) {
    super(message);
    this.name = 'CoreDeviceError';
    this.response = response;
  }
}

export interface CoreDeviceInvokeOptions {
  /** Optional action identifier for the invocation. */
  actionIdentifier?: string;
  /** Override the default response timeout. */
  timeoutMs?: number;
}

/**
 * Base class for iOS CoreDevice (`com.apple.coredevice.*`) services.
 *
 * CoreDevice services speak RemoteXPC over the tunnel and wrap every request in
 * a common invocation envelope. This base owns the framed transport lifecycle
 * and exposes:
 *   - {@link invoke} for request/response features (the common case)
 *   - {@link send} for fire-and-forget messages (e.g. HID events)
 *
 * Subclasses pass their RSD service name to the constructor and typically also
 * expose it via a static `RSD_SERVICE_NAME` for catalog checks.
 */
export abstract class CoreDeviceService extends BaseService {
  private readonly serviceName: string;

  protected transport: RemoteXpcFramedTransport | null = null;
  protected nextMessageId = 1;

  /** Serializes invocations so concurrent calls do not interleave replies. */
  private invokeQueue: Promise<unknown> = Promise.resolve();

  constructor(udid: string, serviceName: string) {
    super(udid);
    this.serviceName = serviceName;
  }

  async close(): Promise<void> {
    if (!this.transport) {
      return;
    }

    const transport = this.transport;
    this.transport = null;
    await transport.close();
  }

  /**
   * Sends a fire-and-forget XPC message on the root channel. Used by services
   * that do not expect a reply (e.g. HID event streams).
   */
  protected async send(body: XPCDictionary): Promise<void> {
    const transport = await this.getTransport();
    transport.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT,
        id: this.nextMessageId++,
        body,
      }),
      Http2Constants.ROOT_CHANNEL,
    );
  }

  /**
   * Invokes a CoreDevice feature and returns its `CoreDevice.output`.
   *
   * Each invocation uses a fresh connection: CoreDevice services close the
   * connection after a request/response cycle, so reusing a connection
   * across invocations fails. Calls are also serialized, so they never overlap.
   */
  protected async invoke(
    featureIdentifier?: string,
    input: XPCDictionary = {},
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCValue> {
    // Serialize invocations: await the previous call's completion, then install
    // a new tail that the next caller will await. Prior failures are ignored so
    // one failed call does not poison the queue.
    const previous = this.invokeQueue;
    let release: () => void = () => undefined;
    this.invokeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await previous;
    } catch {
      // Ignore the previous invocation's outcome.
    }

    try {
      return await this.invokeInternal(featureIdentifier, input, options);
    } finally {
      release();
    }
  }

  protected async createTransport(): Promise<RemoteXpcFramedTransport> {
    const transport = new RemoteXpcFramedTransport(
      await this.resolveServiceAddress(this.serviceName),
    );
    await transport.connect({ timeoutMs: CONNECT_TIMEOUT_MS });
    return transport;
  }

  protected async getTransport(): Promise<RemoteXpcFramedTransport> {
    if (!this.transport?.isConnected) {
      this.transport = await this.createTransport();
      this.nextMessageId = 1;
    }
    return this.transport;
  }

  /**
   * Closes any existing connection and opens a fresh one. Used by {@link invoke}
   * because CoreDevice services are one-shot per connection.
   */
  private async freshTransport(): Promise<RemoteXpcFramedTransport> {
    if (this.transport) {
      const previous = this.transport;
      this.transport = null;
      await previous.close().catch((): void => undefined);
    }
    this.transport = await this.createTransport();
    this.nextMessageId = 1;
    return this.transport;
  }

  private async invokeInternal(
    featureIdentifier: string | undefined,
    input: XPCDictionary,
    options: CoreDeviceInvokeOptions,
  ): Promise<XPCValue> {
    const transport = await this.freshTransport();
    const request = this.buildEnvelope(
      featureIdentifier,
      input,
      options.actionIdentifier,
    );

    // Register the response listener before sending so a fast reply is not lost.
    const responsePromise = this.waitForResponse(
      transport,
      options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      featureIdentifier,
    );

    transport.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT |
          XpcConstants.XPC_FLAGS_WANTING_REPLY,
        id: this.nextMessageId++,
        body: request,
      }),
      Http2Constants.ROOT_CHANNEL,
    );

    const response = await responsePromise;
    const output = response['CoreDevice.output'];
    if (output === undefined) {
      throw new CoreDeviceError(
        `CoreDevice invocation '${featureIdentifier ?? '<none>'}' returned no output`,
        response,
      );
    }
    return output;
  }

  private buildEnvelope(
    featureIdentifier: string | undefined,
    input: XPCDictionary,
    actionIdentifier?: string,
  ): XPCDictionary {
    const request: XPCDictionary = {
      'CoreDevice.CoreDeviceDDIProtocolVersion':
        CORE_DEVICE_DDI_PROTOCOL_VERSION,
      'CoreDevice.coreDeviceVersion': CORE_DEVICE_VERSION,
      'CoreDevice.deviceIdentifier': randomUUID(),
      'CoreDevice.input': input,
      'CoreDevice.invocationIdentifier': randomUUID(),
    };
    if (featureIdentifier !== undefined) {
      request['CoreDevice.featureIdentifier'] = featureIdentifier;
      request['CoreDevice.action'] = {};
    }
    if (actionIdentifier !== undefined) {
      request['CoreDevice.actionIdentifier'] = actionIdentifier;
    }
    return request;
  }

  private waitForResponse(
    transport: RemoteXpcFramedTransport,
    timeoutMs: number,
    featureIdentifier: string | undefined,
  ): Promise<XPCDictionary> {
    return new Promise<XPCDictionary>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        transport.off('message', onMessage);
        transport.off('error', onError);
        transport.off('close', onClose);
      };

      const onMessage = (body: XPCDictionary): void => {
        // Skip empty/handshake acks; the real reply carries CoreDevice.* keys.
        if (
          !body ||
          typeof body !== 'object' ||
          Object.keys(body).length === 0
        ) {
          return;
        }
        cleanup();
        resolve(body);
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const onClose = (): void => {
        cleanup();
        reject(
          new CoreDeviceError(
            `CoreDevice connection closed while awaiting '${featureIdentifier ?? '<none>'}'`,
          ),
        );
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new CoreDeviceError(
            `CoreDevice invocation '${featureIdentifier ?? '<none>'}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      transport.on('message', onMessage);
      transport.once('error', onError);
      transport.once('close', onClose);
    });
  }
}

export default CoreDeviceService;
