import { AfcFopenMode } from './enums.js';

/**
 * AFC protocol constants
 */

// Magic bytes at start of every AFC header
export const AFCMAGIC = Buffer.from('CFA6LPAA', 'ascii');

// IO chunk sizes
export const MAXIMUM_READ_SIZE = 4 * 1024 * 1024; // 4 MiB

// Maximum bytes per AFC WRITE packet.
//
// Emitting one WRITE per 64 KiB source chunk turns a large push into hundreds of
// serial request/response round-trips, each of which can stall on the tunnel
// (the "app install freeze"). We coalesce the stream into WRITEs of up to this
// size, cutting round-trips to ~fileSize/MAXIMUM_WRITE_SIZE.
//
// The size is bounded by two competing constraints:
//  - large enough that round-trip count is small (unlike the old 64 KiB);
//  - small enough that a single WRITE reliably drains + is acked within
//    AFC_OPERATION_TIMEOUT_MS even on a slow tunnel (~0.5-1 MB/s). At 4 MiB that
//    is ~4-8s per write, comfortably under the timeout, while still ~60x fewer
//    round-trips than 64 KiB. (pymobiledevice3 uses 1 GiB but buffers the whole
//    file in memory; we stream, so we keep this bounded and RAM-safe.)
export const MAXIMUM_WRITE_SIZE = 4 * 1024 * 1024; // 4 MiB

// Mapping of textual fopen modes to AFC modes
export const AFC_FOPEN_TEXTUAL_MODES: Record<string, AfcFopenMode> = {
  r: AfcFopenMode.RDONLY,
  'r+': AfcFopenMode.RW,
  w: AfcFopenMode.WRONLY,
  'w+': AfcFopenMode.WR,
  a: AfcFopenMode.APPEND,
  'a+': AfcFopenMode.RDAPPEND,
};

// Header size: magic (8) + entire_length (8) + this_length (8) + packet_num (8) + operation (8)
export const AFC_HEADER_SIZE = 40;

export const AFC_OPERATION_TIMEOUT_MS = 15_000;

// Override for WRITE packets' this_length
export const AFC_WRITE_THIS_LENGTH = 48;

export const NULL_BYTE = Buffer.from([0]);

// File lock operation constants
export const AFC_LOCK_SH = 1 | 4; // 5: Shared lock (multiple readers)
export const AFC_LOCK_EX = 2 | 4; // 6: Exclusive lock (single writer)
export const AFC_LOCK_UN = 8 | 4; // 12: Unlock
