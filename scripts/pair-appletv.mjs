#!/usr/bin/env node
/**
 * Backward-compatible alias for pair-remote-device.mjs.
 * Prefer: `npm run pair-remote-device`
 */
import { main } from './pair-remote-device.mjs';

try {
  await main('pair-appletv');
} catch {
  process.exit(1);
}
