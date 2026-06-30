import {AfcFopenMode} from './enums.js';

/**
 * AFC protocol constants
 */

// Magic bytes at start of every AFC header
export const AFCMAGIC = Buffer.from('CFA6LPAA', 'ascii');

export const MAXIMUM_READ_SIZE = 4 * 1024 * 1024;
export const MAXIMUM_WRITE_SIZE = 4 * 1024 * 1024;

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

export const AFC_OPERATION_TIMEOUT_MS = 30_000;

export const NULL_BYTE = Buffer.from([0]);

// File lock operation constants
export const AFC_LOCK_SH = 1 | 4; // 5: Shared lock (multiple readers)
export const AFC_LOCK_EX = 2 | 4; // 6: Exclusive lock (single writer)
export const AFC_LOCK_UN = 8 | 4; // 12: Unlock
