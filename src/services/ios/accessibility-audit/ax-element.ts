import {util} from '@appium/support';

import {AX_OBJECT_TYPE} from './ax-deserialize.js';

/**
 * A handle to one element in the device's accessibility tree.
 *
 * `platformElement` is the daemon's opaque 20-byte identifier and is what makes
 * the handle usable in later calls — it has to be sent back verbatim.
 */
export interface AxElement {
  /** The daemon's opaque element identifier. */
  platformElement: Buffer;
  /** The element's `accessibilityIdentifier`, when it has one. */
  accessibilityIdentifier?: string;
}

/**
 * One attribute the daemon exposes for an element, e.g. `Label` or `Traits`.
 *
 * These are descriptors only — they carry no value. Reading a value takes a
 * second call (`deviceElement:valueForAttribute:`) passing the element and the
 * descriptor back, which is exactly what Xcode's Inspector does to fill each row
 * of its panel.
 */
export interface AxElementAttribute {
  /** Wire name, e.g. `TraitsHumanReadable`. Pass this back to read a value. */
  name: string;
  /** Display name, e.g. `Traits`. */
  humanReadableName: string;
  /** Whether the value can be written back. */
  settable: boolean;
  /** Whether reading it performs an action rather than returning data. */
  performsAction: boolean;
  /** Whether the daemon considers this internal/debug-only. */
  isInternal: boolean;
  /** The daemon's value-type discriminator. */
  valueType?: number;
  /** The raw descriptor, needed verbatim when asking for the value. */
  raw: Record<string, unknown>;
}

/** A titled group of attributes — `Basic`, `Actions`, `Element`, `Hierarchy`. */
export interface AxInspectorSection {
  /** Stable identifier, e.g. `Basic_v1`. */
  identifier: string;
  /** Display title, e.g. `Basic`. */
  title: string;
  /** The attributes in this section. */
  attributes: AxElementAttribute[];
}

/** The inspector panel the device pushes when the focused element changes. */
export interface AxInspectedElement {
  /**
   * A handle to the focused element, when the daemon sends one.
   *
   * Present on focus pushes, which lets a walk both detect revisits and read
   * attributes for each element it reaches.
   */
  element?: AxElement;
  /** What VoiceOver would announce, when the daemon provides it. */
  spokenDescription?: string;
  /** The caption shown above the panel, when present. */
  caption?: string;
  /** The panel's sections, in the order the device sent them. */
  sections: AxInspectorSection[];
}

/** Recovers a `Buffer` from a decoded `NS.data` blob. */
function toBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (util.isPlainObject(value)) {
    // The archiver decodes NSData into an index-keyed object.
    const bytes = Object.values(value as Record<string, unknown>).filter((b): b is number => typeof b === 'number');
    if (bytes.length > 0) {
      return Buffer.from(bytes);
    }
  }
  return undefined;
}

/**
 * Parses a deserialized `AXAuditElement_v1`.
 *
 * The `_v1` suffixes are the daemon's own wire keys, not our assumption. A
 * future shape would carry different keys, so this returns `undefined` rather
 * than misreading one.
 */
export function toAxElement(value: unknown): AxElement | undefined {
  if (!util.isPlainObject(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const platformValue = fields.PlatformElementValue_v1;
  const container = util.isPlainObject(platformValue)
    ? ((platformValue as Record<string, unknown>)['NS.data'] ?? platformValue)
    : undefined;
  const platformElement = toBuffer(container);
  if (!platformElement) {
    return undefined;
  }
  return {
    platformElement,
    accessibilityIdentifier:
      typeof fields.AccessibilityIdentifier_v1 === 'string' ? fields.AccessibilityIdentifier_v1 : undefined,
  };
}

/**
 * Rebuilds the serialized form the daemon expects when an element is passed
 * back, matching what Xcode's Inspector sends.
 */
export function serializeAxElement(element: AxElement): Record<string, unknown> {
  const value: Record<string, unknown> = {
    PlatformElementValue_v1: {ObjectType: 'passthrough', Value: element.platformElement},
  };
  if (element.accessibilityIdentifier !== undefined) {
    value.AccessibilityIdentifier_v1 = {ObjectType: 'passthrough', Value: element.accessibilityIdentifier};
  }
  return {
    ObjectType: 'AXAuditElement_v1',
    Value: {ObjectType: 'passthrough', Value: value},
  };
}

function toAttribute(value: unknown): AxElementAttribute | undefined {
  if (!util.isPlainObject(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const name = fields.AttributeNameValue_v1;
  if (typeof name !== 'string') {
    return undefined;
  }
  return {
    name,
    humanReadableName: typeof fields.HumanReadableNameValue_v1 === 'string' ? fields.HumanReadableNameValue_v1 : name,
    settable: fields.SettableValue_v1 === true,
    performsAction: fields.PerformsActionValue_v1 === true,
    isInternal: fields.IsInternal_v1 === true,
    valueType: typeof fields.ValueTypeValue_v1 === 'number' ? fields.ValueTypeValue_v1 : undefined,
    raw: stripTag(fields),
  };
}

/** Drops the decoder's type tag so the object round-trips as the daemon sent it. */
function stripTag(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== AX_OBJECT_TYPE));
}

/** Rebuilds an attribute descriptor for the wire. */
export function serializeAxAttribute(attribute: AxElementAttribute): Record<string, unknown> {
  const value = Object.fromEntries(
    Object.entries(attribute.raw).map(([key, inner]) => [key, {ObjectType: 'passthrough', Value: inner}]),
  );
  return {
    ObjectType: 'AXAuditElementAttribute_v1',
    Value: {ObjectType: 'passthrough', Value: value},
  };
}

/** Parses the payload of an inbound `hostInspectorCurrentElementChanged:`. */
export function toInspectedElement(value: unknown): AxInspectedElement {
  const fields = (util.isPlainObject(value) ? value : {}) as Record<string, unknown>;
  const rawSections = Array.isArray(fields.InspectorSectionsValue_v1) ? fields.InspectorSectionsValue_v1 : [];
  const sections: AxInspectorSection[] = [];
  for (const rawSection of rawSections) {
    if (!util.isPlainObject(rawSection)) {
      continue;
    }
    const section = rawSection as Record<string, unknown>;
    const rawAttributes = Array.isArray(section.ElementAttributesValue_v1) ? section.ElementAttributesValue_v1 : [];
    sections.push({
      identifier: typeof section.IdentifierValue_v1 === 'string' ? section.IdentifierValue_v1 : '',
      title: typeof section.TitleValue_v1 === 'string' ? section.TitleValue_v1 : '',
      attributes: rawAttributes
        .map(toAttribute)
        .filter((attribute): attribute is AxElementAttribute => attribute !== undefined),
    });
  }
  return {
    element: toAxElement(fields.ElementValue_v1),
    spokenDescription:
      typeof fields.SpokenDescriptionValue_v1 === 'string' ? fields.SpokenDescriptionValue_v1 : undefined,
    caption: typeof fields.CaptionTextValue_v1 === 'string' ? fields.CaptionTextValue_v1 : undefined,
    sections,
  };
}
