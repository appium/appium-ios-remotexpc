import {util} from '@appium/support';

import {PlistUID} from '../../../lib/plist/index.js';

/**
 * A point passed to the accessibility daemon, in normalized device coordinates
 * (`0..1` across the screen's width and height).
 *
 * Carried as its own type because the daemon calls `CGPointValue` on the
 * argument, so it has to arrive as an `NSValue` wrapping a `CGPoint` — an
 * archived array, dictionary or bare double is rejected. Verified live on
 * iOS 27.0: a double yields "Cannot get value with size 16. The type encoded as
 * d is expected to be 8 bytes", and a dictionary yields
 * "-[__NSDictionaryI CGPointValue]: unrecognized selector".
 */
export class AxPoint {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}

/**
 * Builds the NSKeyedArchiver graph for an `NSValue` holding a `CGPoint`.
 *
 * `NS.special` discriminates the wrapped struct — 1 for a point. The device's
 * own replies use 3 for rects (seen on `ElementRectValue_v1`), which is what
 * corroborates the numbering.
 */
export function archiveAxPoint(point: AxPoint): Record<string, unknown> {
  return {
    $version: 100000,
    $archiver: 'NSKeyedArchiver',
    $top: {root: new PlistUID(1)},
    $objects: [
      '$null',
      {
        'NS.special': 1,
        'NS.pointval': `{${point.x}, ${point.y}}`,
        $class: new PlistUID(2),
      },
      {
        $classes: ['NSValue', 'NSObject'],
        $classname: 'NSValue',
      },
    ],
  };
}

/** An element's on-screen rectangle, in points. */
export interface AxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `NS.special` value marking an `NSValue` that wraps a `CGRect`. */
const NS_SPECIAL_RECT = 3;

/** `{{x, y}, {width, height}}` — Foundation's string form for a `CGRect`. */
const CG_RECT_PATTERN = /^\{\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\s*,\s*\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\}$/;

/**
 * Reads an element's rectangle from an audit issue's `ElementRectValue_v1`.
 *
 * The daemon sends a `CGRect` as an `NSValue` whose struct is a string, e.g.
 * `{{16, 186.33}, {18, 18}}`. Returns `undefined` for anything that is not a
 * rect — including a bare number, which means the archiver reference was never
 * resolved — rather than guessing at partial coordinates.
 *
 * @param value The raw `ElementRectValue_v1` from an audit issue.
 */
export function toAxRect(value: unknown): AxRect | undefined {
  if (!util.isPlainObject(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  if (fields['NS.special'] !== NS_SPECIAL_RECT) {
    return undefined;
  }
  const raw = fields['NS.rectval'];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = CG_RECT_PATTERN.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [x, y, width, height] = match.slice(1, 5).map(Number);
  return [x, y, width, height].every((n) => Number.isFinite(n)) ? {x, y, width, height} : undefined;
}
