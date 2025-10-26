import { AfcFopenMode } from './enums.js';

/**
 * AFC protocol constants
 */

// Magic bytes at start of every AFC header
export const AFCMAGIC = Buffer.from('CFA6LPAA', 'ascii');

// IO chunk sizes
export const MAXIMUM_READ_SIZE = 4 * 1024 * 1024; // 4 MiB

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

// Override for WRITE packets' this_length
export const AFC_WRITE_THIS_LENGTH = 48;

export const NULL_BYTE = Buffer.from([0]);
