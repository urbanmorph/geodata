/** The message shown when /api/submit fails: the server's own words plus the
 *  attempt reference, so the contributor can tell us exactly which attempt. */
export function submitErrorText(status: number, body: { error?: string; attempt_id?: string }): string {
  const message = body.error || `The server returned an error (HTTP ${status}). Please try again.`;
  return body.attempt_id ? `${message} Reference: ${body.attempt_id}` : message;
}

/** A submit that never got an answer from the server (offline, blocked). */
export function submitNetworkErrorText(err: unknown): string {
  return `Couldn't reach bharatlas (${(err as Error)?.message || 'no reply'}). Check your connection and try again.`;
}

/** /preview?url=… could not fetch the file it was given. */
export function urlFetchErrorText(err: unknown): string {
  return `Couldn't fetch that file (${(err as Error)?.message || 'no reply'}).`;
}
