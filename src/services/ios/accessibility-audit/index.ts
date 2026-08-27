import {util} from '@appium/support';

import {getLogger} from '../../../lib/logger.js';
import {MessageAux} from '../dvt/dtx-message.js';
import {AX_OBJECT_TYPE, deserializeAxObject} from './ax-deserialize.js';
import {
  type AxElement,
  type AxElementAttribute,
  type AxInspectedElement,
  serializeAxAttribute,
  serializeAxElement,
  toAxElement,
  toInspectedElement,
} from './ax-element.js';
import {AxAuditDtxTransport, type InvokeOptions} from './dtx-transport.js';

const log = getLogger('AccessibilityAudit');

/** `SettingTypeValue_v1` for a slider setting, e.g. `DYNAMIC_TYPE`. */
const SETTING_TYPE_SLIDER = 2;
/** `SettingTypeValue_v1` for an on/off toggle — every setting bar the slider. */
const SETTING_TYPE_TOGGLE = 3;

/**
 * What each setting type accepts, keyed by `SettingTypeValue_v1`.
 *
 * The device discovers its own catalogue at runtime, so the rules are keyed by
 * type rather than by setting: supporting a new type is one entry here, and an
 * unrecognised type has no entry and is refused.
 */
const SETTING_VALIDATORS = new Map<number, (value: boolean | number, identifier: string) => void>([
  [
    SETTING_TYPE_SLIDER,
    (value, identifier) => {
      // The device clamps out-of-range input to 1 — including negatives — so a
      // typo would silently max the setting out rather than fail.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `Setting "${identifier}" is a slider and expects a number between 0 and 1, got ${JSON.stringify(value)}`,
        );
      }
    },
  ],
  [
    SETTING_TYPE_TOGGLE,
    (value, identifier) => {
      // A toggle takes any truthy value on the wire (0.5 reads back as true),
      // which is too loose to be useful in a typed API.
      if (typeof value !== 'boolean') {
        throw new Error(`Setting "${identifier}" is a toggle and expects a boolean, got ${JSON.stringify(value)}`);
      }
    },
  ],
]);

/** `deviceInspectorSetMonitoredEventType:` value that reports focus changes. */
const MONITORED_EVENT_FOCUS = 2;
/** Value that disarms monitoring. */
const MONITORED_EVENT_OFF = 0;

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

  /** Live {@link observeFocusedElement} subscriptions; monitoring stays armed while > 0. */
  private observerCount = 0;

  /** Guards {@link runAudit} against overlapping calls on one instance. */
  private auditInFlight = false;

  /**
   * Identifier to `SettingTypeValue_v1`, read once per connection.
   *
   * Only a setting's *value* changes; its identity, type and tick marks are
   * fixed for the device, so repeated writes need not re-read the catalogue.
   */
  private settingTypes: Map<string, number | undefined> | undefined;

  /**
   * Supported audit types, read once per connection.
   *
   * Like the setting catalogue this is fixed for the device, so validating a
   * name costs one round trip per connection rather than one per audit.
   */
  private auditTypeNames: Set<string> | undefined;

  private constructor(private readonly transport: AxAuditDtxTransport) {}

  /**
   * Connects to the daemon and completes the DTX handshake.
   *
   * @param udid Target device UDID.
   */
  static async start(udid: string): Promise<AccessibilityAuditService> {
    return new AccessibilityAuditService(await AxAuditDtxTransport.connect(udid));
  }

  /** The daemon's API version (26 on iOS 26.6 and 27.0). */
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
   * Writes one accessibility setting. Applies system-wide, but only while this
   * service is open — closing it reverts the setting.
   *
   * Sliders snap to the device's tick marks (`DYNAMIC_TYPE` has 12, so `0.5`
   * reads back as `0.545`). The device acknowledges a write in a few
   * milliseconds but commits it asynchronously, so back-to-back writes to the
   * same setting are dropped — ~1.5s apart was reliable in testing, and the
   * exact minimum is not published.
   *
   * @param identifier A setting identifier, e.g. `INVERT_COLORS`, `DYNAMIC_TYPE`.
   * @param value `boolean` for a toggle, or a number in 0..1 for a slider.
   * @param options Reply timeout.
   * @throws If the identifier is unknown, or the value is wrong for its type.
   */
  async setAccessibilitySetting(identifier: string, value: boolean | number, options?: InvokeOptions): Promise<void> {
    const schema = await this.loadSettingTypes(options);
    if (!schema.has(identifier)) {
      throw new Error(
        `Unknown accessibility setting "${identifier}"; the device supports: ${[...schema.keys()].join(', ')}`,
      );
    }
    const settingType = schema.get(identifier);
    const validate = settingType === undefined ? undefined : SETTING_VALIDATORS.get(settingType);
    if (!validate) {
      // Only slider and toggle have been observed (iOS 26.6 and 27.0); refuse
      // rather than guess at the value another type expects.
      throw new Error(`Setting "${identifier}" has unsupported type ${JSON.stringify(settingType)}`);
    }
    validate(value, identifier);

    const aux = new MessageAux();
    aux.appendObj(serializeAxSetting(identifier));
    aux.appendObj({ObjectType: 'passthrough', Value: value});
    // The daemon answers (with null), so awaiting it confirms the write landed
    // before a caller screenshots or re-audits.
    await this.transport.invoke('deviceUpdateAccessibilitySetting:withValue:', aux, options);
  }

  /** Reads the setting catalogue once and remembers each identifier's type. */
  private async loadSettingTypes(options?: InvokeOptions): Promise<Map<string, number | undefined>> {
    if (!this.settingTypes) {
      const settings = await this.getAccessibilitySettings(options);
      this.settingTypes = new Map(settings.map((entry) => [entry.identifier, entry.settingType]));
    }
    return this.settingTypes;
  }

  /**
   * Resets the device's stored accessibility settings to their defaults.
   *
   * **Persistent and destructive** — unlike {@link setAccessibilitySetting} this
   * survives disconnect and discards the user's own choices. Session overrides
   * revert on close by themselves, so this is rarely the right cleanup. It also
   * drops overrides held by other connections.
   *
   * @param options Reply timeout.
   */
  async resetAccessibilitySettings(options?: InvokeOptions): Promise<void> {
    await this.transport.invoke('deviceResetToDefaultAccessibilitySettings', null, options);
  }

  /**
   * Runs the given accessibility audits on whatever the device is currently
   * showing and resolves with the issues found (empty when everything passes).
   *
   * The audit begins with a one-way `deviceBeginAuditTypes:` and completes when
   * the device calls back with
   * `hostDeviceDidCompleteAuditCategoriesWithAuditIssues:`.
   *
   * Only one audit may run per service instance — issues arrive on a shared
   * inbound stream, so overlapping calls would each collect the other's. A
   * concurrent call is rejected rather than allowed to mix results; use a second
   * service instance to audit in parallel.
   *
   * @param auditTypes Audit types to run, from {@link getSupportedAuditTypes}.
   * @param options Timeout for the completion callback.
   */
  async runAudit(auditTypes: string[], options: RunAuditOptions = {}): Promise<AxAuditIssue[]> {
    if (this.auditInFlight) {
      throw new Error('An audit is already running on this service instance; await it or use a second instance');
    }
    this.auditInFlight = true;
    // Issues are streamed one per `hostFoundAuditIssue:` call and the
    // completion callback carries no arguments. Older releases are reported to
    // return them in the completion instead, so both are collected and the
    // streamed set wins when present.
    const issues: AxAuditIssue[] = [];
    const stopIssues = this.transport.onInbound('hostFoundAuditIssue:', (args) => {
      const issue = deserializeAxObject(args[0]);
      if (util.isPlainObject(issue)) {
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
      await this.assertKnownAuditTypes(auditTypes, options);
      if (options.targetPid !== undefined) {
        // Narrows the audit to one process; omitted, the daemon uses the
        // foreground app.
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
      const completionArgs = await completion;
      return issues.length > 0 ? issues : issuesFromCompletion(completionArgs);
    } finally {
      this.auditInFlight = false;
      stopIssues();
      stopLog?.();
    }
  }

  /**
   * Rejects audit types the device does not implement.
   *
   * An unrecognised name makes the daemon return neither issues nor a
   * completion, and that connection can never run another audit — so the name
   * must never reach the device.
   */
  private async assertKnownAuditTypes(auditTypes: string[], options?: InvokeOptions): Promise<void> {
    if (auditTypes.length === 0) {
      return;
    }
    this.auditTypeNames ??= new Set(await this.getSupportedAuditTypes(options));
    const unknown = auditTypes.filter((auditType) => !this.auditTypeNames?.has(auditType));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown audit type(s) ${unknown.map((auditType) => JSON.stringify(auditType)).join(', ')}; ` +
          `the device supports: ${[...(this.auditTypeNames ?? [])].join(', ')}`,
      );
    }
  }

  /**
   * Returns the element the device's accessibility focus is currently on.
   *
   * The daemon does not answer a query for this. Xcode's Inspector arms a
   * monitoring session and the device *pushes* the element back as an inbound
   * `hostInspectorCurrentElementChanged:` call, so that is what this reproduces:
   * arm, ask focus to report, wait for the push, disarm. Captured from a live
   * Inspector session — `deviceFetchElementAtNormalizedDeviceCoordinate:`
   * returns `null` on iOS 26.6 and 27.0 no matter how it is called.
   *
   * @param options Timeout, and whether to draw the on-device highlight.
   */
  async getFocusedElement(options: InspectOptions = {}): Promise<AxInspectedElement> {
    const {timeoutMs = 15000, showVisuals = false} = options;
    const pushed = this.transport.waitForInbound('hostInspectorCurrentElementChanged:', timeoutMs);
    this.setMonitoredEventType(MONITORED_EVENT_FOCUS);
    if (showVisuals) {
      this.setShowVisuals(true);
    }
    try {
      const empty = new MessageAux();
      // An empty dictionary means "whatever is focused now" — this is exactly
      // what the Inspector sends.
      empty.appendObj({});
      this.transport.invokeOneway('deviceInspectorFocusOnElement:', empty);
      // `waitForInbound` resolves with the call's whole argument list; the panel
      // is the first argument.
      const [payload] = await pushed;
      return toInspectedElement(deserializeAxObject(payload));
    } finally {
      if (showVisuals) {
        this.setShowVisuals(false);
      }
      // Leave monitoring armed if an observer is relying on it.
      if (this.observerCount === 0) {
        this.setMonitoredEventType(MONITORED_EVENT_OFF);
      }
    }
  }

  /**
   * Subscribes to focus changes, delivering an inspector panel each time the
   * device's accessibility focus moves.
   *
   * Monitoring stays armed until every observer has unsubscribed. The listener
   * is called synchronously; a rejected promise returned from an async one is
   * not awaited, so handle errors inside it.
   *
   * @param listener Receives each pushed element.
   * @param options Whether to draw the on-device highlight.
   */
  observeFocusedElement(
    listener: (element: AxInspectedElement) => void,
    options: {showVisuals?: boolean} = {},
  ): () => void {
    const stop = this.transport.onInbound('hostInspectorCurrentElementChanged:', (args) => {
      listener(toInspectedElement(deserializeAxObject(args[0])));
    });
    this.observerCount += 1;
    this.setMonitoredEventType(MONITORED_EVENT_FOCUS);
    if (options.showVisuals) {
      this.setShowVisuals(true);
    }
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      stop();
      if (options.showVisuals) {
        this.setShowVisuals(false);
      }
      // Only the last observer may disarm; otherwise it would stop the others.
      this.observerCount -= 1;
      if (this.observerCount === 0) {
        this.setMonitoredEventType(MONITORED_EVENT_OFF);
      }
    };
  }

  /**
   * Reads one attribute's value for an element.
   *
   * Attribute descriptors carry no values, so each row of the inspector panel
   * costs one call — the element handle and the descriptor both go back as they
   * arrived.
   *
   * @param element The element handle.
   * @param attribute A descriptor from {@link AxInspectedElement}'s sections.
   * @param options Reply timeout.
   */
  async getElementAttributeValue(
    element: AxElement,
    attribute: AxElementAttribute,
    options?: InvokeOptions,
  ): Promise<unknown> {
    const aux = new MessageAux();
    aux.appendObj(serializeAxElement(element));
    aux.appendObj(serializeAxAttribute(attribute));
    return deserializeAxObject(await this.transport.invoke('deviceElement:valueForAttribute:', aux, options));
  }

  /**
   * Returns one of the daemon's well-known elements.
   *
   * Index `0` and `1` resolve on iOS 26.6 and 27.0; higher return `undefined`.
   *
   * @param index Which special element to fetch.
   * @param options Reply timeout.
   */
  async getSpecialElement(index: number, options?: InvokeOptions): Promise<AxElement | undefined> {
    const aux = new MessageAux();
    aux.appendObj(index);
    const value = deserializeAxObject(await this.transport.invoke('deviceFetchSpecialElement:', aux, options));
    return toAxElement(value);
  }

  /** Arms or disarms the daemon's focus monitoring. */
  private setMonitoredEventType(type: number): void {
    const aux = new MessageAux();
    aux.appendObj(type);
    this.transport.invokeOneway('deviceInspectorSetMonitoredEventType:', aux);
  }

  /** Toggles the on-device highlight the Inspector draws around the element. */
  private setShowVisuals(enabled: boolean): void {
    const aux = new MessageAux();
    aux.appendObj(enabled);
    this.transport.invokeOneway('deviceInspectorShowVisuals:', aux);
  }

  /** Closes the underlying connection. */
  close(): void {
    this.transport.close();
  }
}

/** Options for {@link AccessibilityAuditService.getFocusedElement}. */
export interface InspectOptions {
  /** How long to wait for the device to push the element. Defaults to 15000. */
  timeoutMs?: number;
  /** Draw the Inspector's highlight around the element on the device. */
  showVisuals?: boolean;
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
   * PID of the app to audit. Optional — the daemon audits the foreground app
   * when this is omitted.
   *
   * Set it to audit a specific process regardless of what is frontmost.
   */
  targetPid?: number;
  /** How long to wait for the audit to complete, in milliseconds. */
  timeoutMs?: number;
  /** Receives the device's own audit log lines as they stream in. */
  onLog?: (line: string) => void;
}

/**
 * Recovers audit issues carried in the completion callback's arguments.
 *
 * The device sends no arguments there and streams each issue separately, so this is
 * the fallback path for releases that report them in the completion instead.
 */
function issuesFromCompletion(args: unknown[]): AxAuditIssue[] {
  if (args.length === 0) {
    return [];
  }
  const payload = deserializeAxObject(args[0]);
  if (payload === null || payload === undefined) {
    return [];
  }
  const list = Array.isArray(payload) ? payload : [payload];
  return list.filter((issue): issue is AxAuditIssue => util.isPlainObject(issue));
}

/** Narrows an unknown reply to `string[]`. */
function asStringArray(value: unknown, selector: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Expected ${selector} to return an array of strings, got ${JSON.stringify(value)?.slice(0, 120)}`);
  }
  return value as string[];
}

/**
 * Builds the setting descriptor the daemon expects.
 *
 * Only the identifier is read — the device ignores the type, tick-mark and
 * enabled fields, verified by sending deliberately wrong ones — so this sends
 * the identifier alone rather than echoing a descriptor back.
 */
export function serializeAxSetting(identifier: string): Record<string, unknown> {
  return {
    ObjectType: 'AXAuditDeviceSetting_v1',
    Value: {
      ObjectType: 'passthrough',
      Value: {IdentiifierValue_v1: {ObjectType: 'passthrough', Value: identifier}},
    },
  };
}

/** Maps one deserialized `AXAuditDeviceSetting_v1` to the cleaned shape. */
function toDeviceSetting(raw: unknown): AxDeviceSetting {
  if (!util.isPlainObject(raw)) {
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
