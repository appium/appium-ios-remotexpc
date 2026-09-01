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
 * Where {@link AccessibilityAuditService.moveFocus} sends the accessibility
 * focus. These are the daemon's own `direction` values, verified live.
 */
export enum AxFocusDirection {
  Previous = 3,
  Next = 4,
  First = 5,
  Last = 6,
}

/** Default wait for the focus event a move produces. */
const DEFAULT_FOCUS_TIMEOUT_MS = 15000;

/**
 * How many further elements must keep matching before a repeated step is taken
 * as proof the walk has come round again.
 */
const WALK_PERIOD_CONFIRM_STEPS = 6;

/** Safety valve for {@link AccessibilityAuditService.walkElements}. */
const MAX_WALK_ELEMENTS = 1000;

/**
 * How long to wait for the move onto the first element that opens a walk.
 *
 * When focus already sits there the daemon stays silent rather than answering,
 * so this wait is what the walk pays to find that out. A move that is going to
 * be answered is answered in tens of milliseconds, so this stays well clear of
 * the caller's own budget, which would otherwise be spent in full before the
 * walk could start.
 */
const FOCUS_FIRST_PROBE_TIMEOUT_MS = 2000;

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
  private focusMoveInFlight = false;

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
      await this.assertKnownAuditTypes(auditTypes);
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
  private async assertKnownAuditTypes(auditTypes: string[]): Promise<void> {
    if (auditTypes.length === 0) {
      return;
    }
    // Deliberately not the caller's `timeoutMs`: that budget is for the audit
    // itself, and reusing it here would let a long audit spend it twice.
    const known = this.auditTypeNames ?? new Set(await this.getSupportedAuditTypes());
    if (known.size === 0) {
      // Nothing to validate against. Caching an empty catalogue would reject
      // every type from here on — including after the daemon recovered — which
      // is worse than the wedge this guards against, so let the call through.
      log.debug('Device reported no supported audit types; skipping validation');
      return;
    }
    this.auditTypeNames = known;

    const unknown = auditTypes.filter((auditType) => !known.has(auditType));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown ${util.pluralize('audit type', unknown.length)} ` +
          `${unknown.map((auditType) => JSON.stringify(auditType)).join(', ')}; ` +
          `the device supports: ${[...known].join(', ')}`,
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
   * Moves the device's accessibility focus and resolves with the element it
   * lands on — the same panel {@link getFocusedElement} returns, plus a handle
   * in `element`.
   *
   * The daemon only reports focus that actually *changed*, so a move with
   * nowhere to go — `First` when focus is already on the first element —
   * emits nothing and rejects on timeout. Focus does wrap: `Next` from the last
   * element returns to the first.
   *
   * Only one focus move may be in flight per instance — a second concurrent call
   * rejects, since both would be resolved by the same push.
   *
   * On timeout the move has already been sent, and nothing ties the daemon's
   * push back to the move that caused it. A push landing after the wait gave up
   * is delivered to the next caller, which then sees a stale element — so treat
   * a timeout as "this connection is briefly out of step" and let it settle.
   * Draining blindly does not work: a move that changes nothing is answered with
   * silence, so the event discarded would as often be a real one.
   *
   * @param direction Where to move; see {@link AxFocusDirection}.
   * @param options Timeout, and whether to draw the on-device highlight.
   */
  async moveFocus(direction: AxFocusDirection, options: InspectOptions = {}): Promise<AxInspectedElement> {
    const {timeoutMs = DEFAULT_FOCUS_TIMEOUT_MS, showVisuals = false} = options;
    this.beginFocusWork(showVisuals);
    try {
      return await this.requestFocusMove(direction, timeoutMs);
    } finally {
      this.endFocusWork(showVisuals);
    }
  }

  /**
   * Sends one move and waits for the focus event it produces.
   *
   * Assumes monitoring is already armed, so a walk can arm once instead of once
   * per step.
   */
  private async requestFocusMove(direction: AxFocusDirection, timeoutMs: number): Promise<AxInspectedElement> {
    // Registered before the move is sent so the push cannot be missed, and
    // awaited unconditionally: an abandoned waiter rejects with nothing
    // listening once the connection closes, which is an unhandled rejection
    // rather than an error the caller can catch.
    const pushed = this.transport.waitForInbound('hostInspectorCurrentElementChanged:', timeoutMs);
    const aux = new MessageAux();
    // Every value is envelope-wrapped: a bare `{direction: n}` is accepted on
    // the wire but moves nothing.
    aux.appendObj({
      ObjectType: 'passthrough',
      Value: {
        allowNonAX: {ObjectType: 'passthrough', Value: 0},
        direction: {ObjectType: 'passthrough', Value: direction},
        includeContainers: {ObjectType: 'passthrough', Value: 1},
      },
    });
    this.transport.invokeOneway('deviceInspectorMoveWithOptions:', aux);
    const [payload] = await pushed;
    return toInspectedElement(deserializeAxObject(payload));
  }

  /** Arms monitoring for focus work and rejects a second concurrent caller. */
  private beginFocusWork(showVisuals: boolean): void {
    if (this.focusMoveInFlight) {
      throw new Error('A focus move is already running on this service instance; await it or use a second instance');
    }
    this.focusMoveInFlight = true;
    this.setMonitoredEventType(MONITORED_EVENT_FOCUS);
    if (showVisuals) {
      this.setShowVisuals(true);
    }
  }

  /** Undoes {@link beginFocusWork}, leaving monitoring armed for any observer. */
  private endFocusWork(showVisuals: boolean): void {
    this.focusMoveInFlight = false;
    if (showVisuals) {
      this.setShowVisuals(false);
    }
    if (this.observerCount === 0) {
      this.setMonitoredEventType(MONITORED_EVENT_OFF);
    }
  }

  /**
   * Walks the focusable elements of whatever is on screen, in focus order.
   *
   * Moves focus forward, yielding each element, and stops once the sequence
   * starts repeating — the daemon cycles rather than reporting an end.
   *
   * What counts as a repeat is the step *between* two elements, not an element,
   * because nothing the daemon sends identifies one. {@link
   * AxElement.platformElement} is a fresh handle per focus event, and
   * `accessibilityIdentifier` is absent on most elements, so a screen of
   * lookalikes — a photo grid announcing "Photo, Image" over and over — offers
   * nothing to tell its elements apart. Runs of identical announcements are
   * therefore collapsed for repeat detection and still yielded individually,
   * and the walk stops only when a *pair* of announcements recurs.
   *
   * A repeated step is treated as a hypothesis rather than proof: the walk keeps
   * going and only stops once the announcements have kept matching one period
   * back for several more elements. A screen that happens to take the same step
   * twice is therefore walked in full, where believing the first repeat would
   * have cut it short.
   *
   * The consequence worth knowing: a screen whose announcements repeat over a
   * long enough stretch to satisfy that check still ends early, and one where
   * every element announces alike runs to the safety limit.
   *
   * A screen with nothing focusable yields nothing. Note the daemon reports what
   * is actually drawn, so an app that has not rendered looks empty.
   *
   * Moving focus is a device-wide action: it leaves the focus wherever the walk
   * finished.
   *
   * Read an element's attributes **inside** the loop. `element` is only valid
   * while it holds focus — {@link getElementAttributeValue} returns real values
   * for the element being yielded and `null` for one the walk has moved past.
   *
   * @example
   * ```ts
   * for await (const focused of audit.walkElements()) {
   *   const basic = focused.sections.find((section) => section.title === 'Basic');
   *   const label = basic?.attributes.find((attribute) => attribute.name === 'Label');
   *   // Read now: after the next iteration this element is no longer focused.
   *   const value = label && focused.element
   *     ? await audit.getElementAttributeValue(focused.element, label)
   *     : undefined;
   * }
   * ```
   *
   * @param options Timeout per step, and whether to draw the on-device highlight.
   */
  async *walkElements(options: InspectOptions = {}): AsyncGenerator<AxInspectedElement, void, unknown> {
    const {timeoutMs = DEFAULT_FOCUS_TIMEOUT_MS, showVisuals = false} = options;
    /** Every announcement seen so far, so a candidate period can be checked against it. */
    const history: string[] = [];
    /** Where each step between two announcements was first seen. */
    const firstSeen = new Map<string, number>();
    /** Elements not yet known to be new; dropped if the walk turns out to be repeating. */
    let held: AxInspectedElement[] = [];
    let candidate: {period: number; confirmed: number} | undefined;

    this.beginFocusWork(showVisuals);
    try {
      for (let step = 0; step < MAX_WALK_ELEMENTS; step += 1) {
        let element: AxInspectedElement;
        try {
          element =
            step === 0
              ? await this.requestFocusMove(AxFocusDirection.First, Math.min(timeoutMs, FOCUS_FIRST_PROBE_TIMEOUT_MS))
              : await this.requestFocusMove(AxFocusDirection.Next, timeoutMs);
        } catch {
          if (step > 0) {
            // Focus stopped moving. That is how a screen with a single focusable
            // element ends, so the walk finishes with what it has rather than
            // discarding it and rejecting.
            log.debug('Focus stopped moving; ending the walk');
            break;
          }
          // The opening move changed nothing, so focus already sits where the
          // walk would have put it. `deviceInspectorFocusOnElement:` cannot be
          // used to pick it up — it answers with a panel carrying no element
          // handle — so the walk simply advances from here. Focus cycles, so
          // every element is still reached, just starting one along.
          log.debug('Opening move changed nothing; walking on from where focus is');
          continue;
        }

        const announcement = element.element?.platformElement
          ? (element.caption ?? element.spokenDescription)
          : undefined;
        if (announcement === undefined) {
          // Nothing focusable, or nothing said about it: an empty or undrawn screen.
          log.debug('Focus returned nothing to identify; ending the walk');
          break;
        }

        const index = history.length;
        history.push(announcement);
        if (index > 0 && announcement !== history[index - 1]) {
          const transition = `${history[index - 1]}\u0000${announcement}`;
          // Kept at its earliest index: the distance back to the *first* time a
          // step was taken is what gives the true period.
          const seenAt = firstSeen.get(transition);
          if (seenAt === undefined) {
            firstSeen.set(transition, index);
          } else if (!candidate) {
            // A repeated step only *suggests* the walk has come round again.
            // Confirm it before believing it, by checking the announcements keep
            // matching one period back.
            candidate = {period: index - seenAt, confirmed: 0};
          }
        }

        if (candidate) {
          const matches = history[index] === history[index - candidate.period];
          if (matches) {
            candidate.confirmed += 1;
            held.push(element);
            if (candidate.confirmed >= WALK_PERIOD_CONFIRM_STEPS) {
              // The sequence really is repeating, so everything held back is a
              // revisit and goes with it.
              log.debug(`Walk came full circle after ${candidate.period} element(s)`);
              return;
            }
            continue;
          }
          // The repeat was a coincidence — a screen may well take the same step
          // twice without having come round. Nothing held was a revisit.
          log.debug('A repeated step did not hold up; continuing the walk');
          candidate = undefined;
          yield* held;
          held = [];
        }

        // Held back only to see whether it was the wrap; it was not.
        yield* held;
        held = [];

        if (index > 0 && announcement === history[0]) {
          // Possibly the wrap. Decided on the next step, so that the element the
          // walk opened on is not yielded twice.
          held.push(element);
        } else {
          yield element;
        }
      }

      yield* held;
    } finally {
      this.endFocusWork(showVisuals);
    }
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
