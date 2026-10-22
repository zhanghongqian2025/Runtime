import { randomBytes } from 'node:crypto';

/**
 * Identifier helpers.
 *
 * Identifiers are opaque, URL-safe and unguessable: a session id must not be
 * derivable by a client, because it is used as a directory name on disk.
 */

export const ID_KINDS = ['session', 'turn', 'toolCall', 'request', 'message'] as const;
export type IdKind = (typeof ID_KINDS)[number];

export const ID_PREFIX: Readonly<Record<IdKind, string>> = {
  session: 'sess',
  turn: 'turn',
  toolCall: 'tool',
  request: 'req',
  message: 'msg',
};

/** RFC 4648 base32 alphabet, lowercase (a-z plus 2-7). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_BODY_LENGTH = 26;

const ID_PATTERN: Readonly<Record<IdKind, RegExp>> = {
  session: /^sess_[a-z2-7]{26}$/,
  turn: /^turn_[a-z2-7]{26}$/,
  toolCall: /^tool_[a-z2-7]{26}$/,
  request: /^req_[a-z2-7]{26}$/,
  message: /^msg_[a-z2-7]{26}$/,
};

/**
 * Create a new opaque identifier.
 *
 * `256 % 32 === 0`, so the byte-to-alphabet mapping is uniform and needs no
 * rejection sampling.
 */
export function newId(kind: IdKind): string {
  const bytes = randomBytes(ID_BODY_LENGTH);
  let body = '';
  for (const byte of bytes) {
    body += BASE32_ALPHABET.charAt(byte % 32);
  }
  return `${ID_PREFIX[kind]}_${body}`;
}

/** Narrowing check for a well-formed identifier of the given kind. */
export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN[kind].test(value);
}

/** Parse an identifier, returning `undefined` for anything unrecognised. */
export function parseId(kind: IdKind, value: unknown): string | undefined {
  return isId(kind, value) ? value : undefined;
}

/** Event ids are derived from the turn id and the turn-scoped sequence. */
export function newEventId(turnId: string, seq: number): string {
  return `${turnId}:${seq}`;
}

export const EVENT_ID_PATTERN = /^turn_[a-z2-7]{26}:[1-9][0-9]*$/;

/** Narrowing check for a well-formed event id. */
export function isEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
}
