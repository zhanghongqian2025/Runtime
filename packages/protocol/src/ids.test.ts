import { describe, expect, it } from 'vitest';
import { ID_KINDS, isEventId, isId, newEventId, newId, parseId } from './ids.js';

describe('identifiers', () => {
  it('creates well-formed ids for every kind', () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind);
      expect(isId(kind, id), id).toBe(true);
    }
  });

  it('never repeats an id', () => {
    const ids = new Set(Array.from({ length: 256 }, () => newId('session')));
    expect(ids.size).toBe(256);
  });

  it('rejects malformed ids instead of throwing', () => {
    expect(isId('session', 'sess_short')).toBe(false);
    expect(isId('session', newId('turn'))).toBe(false);
    expect(isId('session', undefined)).toBe(false);
    expect(isId('session', 42)).toBe(false);
  });

  it('returns undefined for unparseable ids', () => {
    expect(parseId('session', 'not-an-id')).toBeUndefined();
    expect(parseId('turn', null)).toBeUndefined();
    expect(parseId('request', {})).toBeUndefined();
  });

  it('builds event ids from a turn id and a turn-scoped sequence', () => {
    const turnId = newId('turn');
    const eventId = newEventId(turnId, 3);
    expect(eventId).toBe(`${turnId}:3`);
    expect(isEventId(eventId)).toBe(true);
    expect(isEventId(`${turnId}:0`)).toBe(false);
    expect(isEventId('nope')).toBe(false);
  });
});
