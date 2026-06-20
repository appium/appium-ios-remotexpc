import { randomUUID } from 'node:crypto';

import { RemoteXpcRequestResponseClient } from '../../../lib/remote-xpc/remote-xpc-request-response-client.js';
import type { XPCDictionary, XPCValue } from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const CORE_DEVICE_VERSION = '629.3';
const CORE_DEVICE_VERSION_COMPONENTS = CORE_DEVICE_VERSION.split('.').map(
  (component) => BigInt(component),
);

export interface CoreDeviceInvokeOptions {
  actionIdentifier?: string;
  timeout?: number;
}

export class CoreDeviceError extends Error {
  constructor(featureIdentifier: string, response: XPCDictionary) {
    super(`Failed to invoke ${featureIdentifier}: ${JSON.stringify(response)}`);
    this.name = 'CoreDeviceError';
  }
}

/**
 * Shared client for CoreDevice services exposed directly through RemoteXPC.
 */
export abstract class CoreDeviceService extends BaseService {
  private readonly serviceName: string;
  private connection: RemoteXpcRequestResponseClient | null = null;

  protected constructor(udid: string, serviceName: string) {
    super(udid);
    this.serviceName = serviceName;
  }

  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    await this.connection.close();
    this.connection = null;
  }

  protected async invoke(
    featureIdentifier: string,
    input: XPCDictionary = {},
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCValue> {
    const response = await this.getConnection().then((connection) =>
      connection.sendReceiveRequest(
        buildCoreDeviceInvokeRequest(
          featureIdentifier,
          input,
          options.actionIdentifier,
        ),
        options.timeout,
      ),
    );
    const output = response['CoreDevice.output'];
    if (output === undefined || output === null) {
      throw new CoreDeviceError(featureIdentifier, response);
    }
    return output;
  }

  private async getConnection(): Promise<RemoteXpcRequestResponseClient> {
    if (this.connection) {
      return this.connection;
    }

    const [host, port] = await this.resolveServiceAddress(this.serviceName);
    const connection = new RemoteXpcRequestResponseClient([host, port]);
    await connection.connect();
    this.connection = connection;
    return connection;
  }
}

/**
 * Build the CoreDevice invoke envelope used by direct CoreDevice services.
 */
export function buildCoreDeviceInvokeRequest(
  featureIdentifier: string,
  input: XPCDictionary = {},
  actionIdentifier?: string,
): XPCDictionary {
  const request: XPCDictionary = {
    'CoreDevice.CoreDeviceDDIProtocolVersion': 2,
    'CoreDevice.action': {},
    'CoreDevice.coreDeviceVersion': {
      components: CORE_DEVICE_VERSION_COMPONENTS,
      originalComponentsCount: CORE_DEVICE_VERSION_COMPONENTS.length,
      stringValue: CORE_DEVICE_VERSION,
    },
    'CoreDevice.deviceIdentifier': randomUUID(),
    'CoreDevice.featureIdentifier': featureIdentifier,
    'CoreDevice.input': input,
    'CoreDevice.invocationIdentifier': randomUUID(),
  };

  if (actionIdentifier !== undefined) {
    request['CoreDevice.actionIdentifier'] = actionIdentifier;
  }

  return request;
}
