// Telling a lost connection from other failures, for the "No connection" messages
// in bharatlas (a layer that can't load) and collect (the map background).

/**
 * Whether a failure was the connection, not the server: the phone says it is
 * offline, or the request got no answer at all (status 0, or a failed fetch,
 * worded differently by Chrome, Firefox and Safari).
 */
export function isConnectionError(err: unknown, online: boolean): boolean {
  if (!online) return true;
  if (!(err instanceof Error)) return false;
  if ((err as Error & { status?: number }).status === 0) return true;
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}
