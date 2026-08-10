import {getLogger} from '../../../lib/logger.js';
import {MessageAux} from '../dvt/dtx-message.js';
import {AX_OBJECT_TYPE, deserializeAxObject} from './ax-deserialize.js';
import {AxAuditDtxTransport, type InvokeOptions} from './dtx-transport.js';

const log = getLogger('AccessibilityAudit');

/**
 * One accessibility setting reported by
 * {@link AccessibilityAuditService.getAccessibilitySettings}.
 *
 * The daemon names fields with a `_v1` suffix (and ships the historical typo
 * `IdentiifierValue_v1`); this is the cleaned form. Unknown fields are preserved
 * via the index signature so nothing is silently dropped.
 */
export interface AxDeviceSetting {
  /** Stable identifier, e.g. `INVERT_COLORS`, `REDUCE_MOTION`. */
  identifier: string;
  /** The daemon's setting-type discriminator. */
  settingType?: number;
  /** Current value — a boolean toggle, a number, or a string depending on type. */
  currentValue?: unknown;
  /** Whether the setting is currently enabled/available. */
  enabled?: boolean;
  /** Tick-mark count for slider-style settings. */
  sliderTickMarks?: number;
  [key: string]: unknown;
}

/**
 * CoreDevice accessibility audit service
 * (`com.apple.accessibility.axAuditDaemon.remoteserver`) — the backend behind
 * Xcode's Accessibility Inspector.
 *
 * Exposes the device's accessibility model over DTX: the audit catalogue,
 * accessibility settings, and (later) the element tree and on-device audits.
 * See {@link AxAuditDtxTransport} for the connection details that make this
 * reachable over the RemoteXPC tunnel.
 *
 * @example
 * ```ts
 * const audit = await Services.startAccessibilityAuditService(udid);
 * try {
 *   const settings = await audit.getAccessibilitySettings();
 * } finally {
 *   audit.close();
 * }
 * ```
 */
export class AccessibilityAuditService {
  static readonly RSD_SERVICE_NAME = AxAuditDtxTransport.RSD_SERVICE_NAME;

  private constructor(private readonly transport: AxAuditDtxTransport) {}

  /**
   * Connects to the daemon and completes the DTX handshake.
   *
   * @param udid Target device UDID.
   */
  static async start(udid: string): Promise<AccessibilityAuditService> {
    return new AccessibilityAuditService(await AxAuditDtxTransport.connect(udid));
  }

  /** The daemon's API version (26 on iOS 27.0). */
  async getApiVersion(options?: InvokeOptions): Promise<number> {
    const value = await this.transport.invoke('deviceApiVersion', null, options);
    if (typeof value !== 'number') {
      throw new Error(`Expected a numeric API version, got ${JSON.stringify(value)}`);
    }
    return value;
  }

  /** The selectors the device's daemon implements. */
  async getCapabilities(options?: InvokeOptions): Promise<string[]> {
    return asStringArray(await this.transport.invoke('deviceCapabilities', null, options), 'deviceCapabilities');
  }

  /** The audit types the device supports, e.g. `testTypeContrast`. */
  async getSupportedAuditTypes(options?: InvokeOptions): Promise<string[]> {
    return asStringArray(
      await this.transport.invoke('deviceAllSupportedAuditTypes', null, options),
      'deviceAllSupportedAuditTypes',
    );
  }

  /**
   * The device's accessibility settings and their current values.
   */
  async getAccessibilitySettings(options?: InvokeOptions): Promise<AxDeviceSetting[]> {
    const raw = deserializeAxObject(await this.transport.invoke('deviceAccessibilitySettings', null, options));
    if (!Array.isArray(raw)) {
      throw new Error(`Expected an array of settings, got ${JSON.stringify(raw)?.slice(0, 120)}`);
    }
    return raw.map(toDeviceSetting);
  }

  /**
   * Runs the given accessibility audits on whatever the device is currently
   * showing and resolves with the issues found (empty when everything passes).
   *
   * The audit begins with a one-way `deviceBeginAuditTypes:` and completes when
   * the device calls back with
   * `hostDeviceDidCompleteAuditCategoriesWithAuditIssues:`.
   *
   * @param auditTypes Audit types to run, from {@link getSupportedAuditTypes}.
   * @param options Timeout for the completion callback.
   */
  async runAudit(auditTypes: string[], options: RunAuditOptions = {}): Promise<AxAuditIssue[]> {
    // Issues are streamed one per `hostFoundAuditIssue:` call, not returned in
    // the completion callback (whose argument list is empty). Collect them as
    // they arrive and stop when the completion call lands.
    const issues: AxAuditIssue[] = [];
    const stopIssues = this.transport.onInbound('hostFoundAuditIssue:', (args) => {
      const issue = deserializeAxObject(args[0]);
      if (issue && typeof issue === 'object') {
        issues.push(issue as AxAuditIssue);
      }
    });
    const stopLog = options.onLog
      ? this.transport.onInbound('hostAppendAuditLog:', (args) => {
          if (typeof args[0] === 'string') {
            options.onLog?.(args[0]);
          }
        })
      : undefined;

    try {
      if (options.targetPid !== undefined) {
        // Without a target the daemon audits nothing and reports no issues.
        const pidAux = new MessageAux();
        pidAux.appendObj(options.targetPid);
        this.transport.invokeOneway('deviceSetAuditTargetPid:', pidAux);
      }
      const completion = this.transport.waitForInbound(
        'hostDeviceDidCompleteAuditCategoriesWithAuditIssues:',
        options.timeoutMs,
      );
      const aux = new MessageAux();
      aux.appendObj(auditTypes);
      this.transport.invokeOneway('deviceBeginAuditTypes:', aux);
      await completion;
      // The completion call can land marginally before the last issue is read
      // off the socket, so let the queue drain.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return issues;
    } finally {
      stopIssues();
      stopLog?.();
    }
  }

  /** Closes the underlying connection. */
  close(): void {
    this.transport.close();
  }
}

/**
 * One accessibility issue from {@link AccessibilityAuditService.runAudit}.
 *
 * The daemon's fields carry `_v1` suffixes and vary by audit type, so this is
 * an open shape — the tag under {@link AX_OBJECT_TYPE} identifies the concrete
 * type (`AXAuditIssue_v1`).
 */
export type AxAuditIssue = Record<string, unknown>;

/** Options for {@link AccessibilityAuditService.runAudit}. */
export interface RunAuditOptions {
  /**
   * PID of the app to audit.
   *
   * Strongly recommended: with no target the daemon audits nothing and reports
   * zero issues, which is indistinguishable from a clean pass.
   */
  targetPid?: number;
  /** How long to wait for the audit to complete, in milliseconds. */
  timeoutMs?: number;
  /** Receives the device's own audit log lines as they stream in. */
  onLog?: (line: string) => void;
}

/** Narrows an unknown reply to `string[]`. */
function asStringArray(value: unknown, selector: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Expected ${selector} to return an array of strings, got ${JSON.stringify(value)?.slice(0, 120)}`);
  }
  return value as string[];
}

/** Maps one deserialized `AXAuditDeviceSetting_v1` to the cleaned shape. */
function toDeviceSetting(raw: unknown): AxDeviceSetting {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Malformed accessibility setting: ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  const fields = raw as Record<string, unknown>;
  const identifier = fields.IdentiifierValue_v1;
  if (typeof identifier !== 'string') {
    log.debug(`Setting without a string identifier: ${JSON.stringify(fields)?.slice(0, 120)}`);
  }
  return {
    ...fields,
    identifier: typeof identifier === 'string' ? identifier : String(identifier),
    settingType: typeof fields.SettingTypeValue_v1 === 'number' ? fields.SettingTypeValue_v1 : undefined,
    currentValue: fields.CurrentValueNumber_v1,
    enabled: typeof fields.EnabledValue_v1 === 'boolean' ? fields.EnabledValue_v1 : undefined,
    sliderTickMarks: typeof fields.SliderTickMarksValue_v1 === 'number' ? fields.SliderTickMarksValue_v1 : undefined,
  };
}

export {AxAuditDtxTransport, AX_OBJECT_TYPE, MessageAux};
export default AccessibilityAuditService;
