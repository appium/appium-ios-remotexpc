import type { XPCDictionary } from '../../../lib/types.js';

export const GENERAL_PASTEBOARD = 'general';

export const PASTEBOARD_COMMAND = {
  PULL: 'PULL',
  PULL_REPLY: 'PULL_REPLY',
  SET: 'SET',
  SET_REPLY: 'SET_REPLY',
  DATA: 'DATA',
  PUSH: 'PUSH',
  AUTONOTIFY: 'AUTONOTIFY',
  RESOLVE: 'RESOLVE',
} as const;

export const PASTEBOARD_UTI = {
  UTF8_PLAIN_TEXT: 'public.utf8-plain-text',
  PLAIN_TEXT: 'public.plain-text',
  TEXT: 'public.text',
  URL: 'public.url',
  PNG: 'public.png',
  JPEG: 'public.jpeg',
  TIFF: 'public.tiff',
  IMAGE: 'public.image',
} as const;

export const PASTEBOARD_POLICY = {
  ALL_RESOLVED: { allResolved: {} },
  ALL_PROMISED: { allPromised: {} },
  MATCH_SOURCE: { matchSource: {} },
  PROMISE_SECONDARY: { promiseSecondary: {} },
} as const satisfies Record<string, XPCDictionary>;

export const TEXT_UTIS = [
  PASTEBOARD_UTI.UTF8_PLAIN_TEXT,
  PASTEBOARD_UTI.PLAIN_TEXT,
  PASTEBOARD_UTI.TEXT,
] as const;
export const URL_UTIS = [PASTEBOARD_UTI.URL, ...TEXT_UTIS] as const;
export const IMAGE_UTIS = [
  PASTEBOARD_UTI.PNG,
  PASTEBOARD_UTI.JPEG,
  PASTEBOARD_UTI.TIFF,
  PASTEBOARD_UTI.IMAGE,
] as const;
