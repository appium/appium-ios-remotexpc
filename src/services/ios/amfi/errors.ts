/**
 * Raised when the AMFI daemon rejects a Developer Mode action; `code` carries the daemon's raw `Error` string.
 */
export class AmfiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AmfiError';
    this.code = code;
  }
}

/**
 * Raised when Developer Mode cannot be enabled because the device has a passcode set.
 * Remove the passcode and retry, or enable Developer Mode from Settings on the device.
 */
export class DeviceHasPasscodeSetError extends AmfiError {
  static readonly CODE = 'Device has a passcode set';

  constructor() {
    super(
      'Developer Mode cannot be enabled remotely while the device has a passcode set. ' +
        'Remove the passcode and retry, or enable it on the device under Settings > Privacy & Security > Developer Mode.',
      DeviceHasPasscodeSetError.CODE,
    );
    this.name = 'DeviceHasPasscodeSetError';
  }
}
