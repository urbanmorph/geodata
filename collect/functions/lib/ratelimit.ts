// Rate limits on the shared rate_limits table (spec → Anti-abuse: 5 collections
// per day per network, 200 records per hour per link and network). Keys are
// hashed IPs (collect uses a DISTINCT IP_SALT from web, so its rows never
// collide with submit's), optionally prefixed. Records use the hour window;
// creates use the day window: independent columns on the same row.

import { bumpWindow } from '../../../shared/rate-window';

type DB = Pick<D1Database, 'prepare'>;

// The atomic upsert lives in shared/rate-window.ts (web's /api/submit uses it too).
const bump = (db: DB, key: string, window: 'hour' | 'day', limit: number): Promise<boolean> =>
  bumpWindow(db, key, window, limit);

/** Points per hour, per link and network: two teams behind one mobile carrier's
 *  shared IP (CGNAT) don't eat each other's budget. */
export const checkRecordRate = (db: DB, key: string): Promise<boolean> => bump(db, key, 'hour', 200);
export const recordRateKey = (linkId: string, ipHash: string): string => `rec:${linkId}:${ipHash}`;
export const checkCreateRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, ipHash, 'day', 5);
// Per-API-key day window (its own rate_limits row, keyed by the key hash).
export const checkKeyDayRate = (db: DB, keyHash: string, limit: number): Promise<boolean> => bump(db, keyHash, 'day', limit);
// Keyring writes: their own rate_limits row (prefixed key) so sync never eats
// into a contributor's record budget.
export const checkKeyringRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, `kr:${ipHash}`, 'hour', 120);
// Photo uploads: their own row (up to 3 photos a point, so 3x the record budget).
export const checkPhotoRate = (db: DB, ipHash: string): Promise<boolean> => bump(db, `ph:${ipHash}`, 'hour', 600);
