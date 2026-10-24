/** The message shown when /api/submit fails: the server's own words plus the
 *  attempt reference, so the contributor can tell us exactly which attempt. */
export function submitErrorText(status: number, body: { error?: string; attempt_id?: string }): string {
  const message = body.error || `The server returned an error (HTTP ${status}). Please try again.`;
  return body.attempt_id ? `${message} Reference: ${body.attempt_id}` : message;
}
