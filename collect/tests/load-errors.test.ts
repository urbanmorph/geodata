// What a contributor sees when a collect map can't open: plain words for a link
// the owner turned off (or a map that no longer exists: the server answers the
// same, so as not to reveal which maps exist), or no connection.
import { describe, it, expect } from 'vitest';
import { ApiError, loadErrorText, LINK_OFF } from '../src/api';

describe('why a map could not open', () => {
  it('a link the owner turned off (or a wrong one) says so, and what to do', () => {
    const text = loadErrorText(new ApiError('unauthorised', 401));
    expect(text).toBe(LINK_OFF);
    expect(LINK_OFF).toMatch(/no longer works/);
    expect(LINK_OFF).toMatch(/deleted/);
    expect(LINK_OFF).toMatch(/ask (the person|whoever) who shared it/i);
  });
  it('offline, keeps the offline explanation', () => {
    const offline = new Error("You're offline, and this map hasn't been opened on this device with a connection yet.");
    expect(loadErrorText(offline)).toBe(offline.message);
  });
  it('anything else keeps the server\'s reason', () => {
    expect(loadErrorText(new ApiError('rate limit', 429))).toBe('rate limit');
  });
});
