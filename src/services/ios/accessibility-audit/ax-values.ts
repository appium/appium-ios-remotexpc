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
