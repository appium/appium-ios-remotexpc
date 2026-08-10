/**
 * The accessibility audit daemon wraps every value it returns in a recursive
 * `{Value, ObjectType}` envelope. `ObjectType: "passthrough"` is a plain boxed
 * value; any other `ObjectType` names a typed object (e.g.
 * `AXAuditDeviceSetting_v1`) whose `Value` is a dictionary of fields.
 */

/** Key under which a typed (non-passthrough) object records its `ObjectType`. */
export const AX_OBJECT_TYPE = '__axObjectType';

/** A decoded typed object: its fields plus the {@link AX_OBJECT_TYPE} tag. */
export type AxTypedObject = Record<string, unknown> & {[AX_OBJECT_TYPE]: string};

function isEnvelope(value: unknown): value is {Value: unknown; ObjectType: string} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'ObjectType' in value &&
    typeof (value as {ObjectType: unknown}).ObjectType === 'string'
  );
}

/**
 * Recursively unwraps the daemon's serialized-object envelopes.
 *
 * @param value A value decoded from an NSKeyedArchiver reply.
 */
export function deserializeAxObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deserializeAxObject);
  }
  if (!isEnvelope(value)) {
    if (typeof value === 'object' && value !== null) {
      // A plain dictionary with no ObjectType: deserialize each field.
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = deserializeAxObject(inner);
      }
      return out;
    }
    return value;
  }

  const inner = deserializeAxObject(value.Value);
  if (value.ObjectType === 'passthrough') {
    return inner;
  }
  // A typed object. Spread its fields (when it has them) and tag the type.
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
    return {...(inner as Record<string, unknown>), [AX_OBJECT_TYPE]: value.ObjectType};
  }
  return {value: inner, [AX_OBJECT_TYPE]: value.ObjectType};
}
