// What collect says when something can't load for lack of a connection.
import { describe, it, expect } from 'vitest';
import { basemapOfflineNote, isConnectionError } from '../src/offline-notes';

describe('the map background with no connection', () => {
  it('Streets: says the background is not saved on this phone, and that points still save', () => {
    const note = basemapOfflineNote({ id: 'liberty', name: 'Streets' });
    expect(note).toMatch(/^No connection/);
    expect(note).toContain("isn't saved on this phone");
    expect(note).toContain('points still save');
  });
  it('the online-only maps say they need the internet, by name', () => {
    expect(basemapOfflineNote({ id: 'satellite', name: 'Esri Imagery' })).toContain('Esri Imagery needs the internet');
    expect(basemapOfflineNote({ id: 'osm', name: 'OpenStreetMap' })).toContain('OpenStreetMap needs the internet');
  });
});

describe('telling a lost connection from other failures', () => {
  it('the phone reports offline: always a connection problem', () => {
    expect(isConnectionError(new Error('anything'), false)).toBe(true);
  });
  it('online but the request never got an answer (status 0, or a failed fetch)', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { status: 0 }), true)).toBe(true);
    expect(isConnectionError(new TypeError('Failed to fetch'), true)).toBe(true);
    expect(isConnectionError(new TypeError('NetworkError when attempting to fetch resource.'), true)).toBe(true);
    expect(isConnectionError(new TypeError('Load failed'), true)).toBe(true); // Safari
  });
  it('a server answer (404, 500) or anything else is not', () => {
    expect(isConnectionError(Object.assign(new Error('Not Found'), { status: 404 }), true)).toBe(false);
    expect(isConnectionError(new Error('bad tile'), true)).toBe(false);
    expect(isConnectionError(undefined, true)).toBe(false);
  });
});
