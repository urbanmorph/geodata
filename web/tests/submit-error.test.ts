import { describe, it, expect } from 'vitest';
import { submitErrorText } from '../src/submit-error';

// A contributor who hits an error must see what happened and a reference they
// can send us, never a bare status code.
describe('submitErrorText', () => {
  it('shows the server message with the reference', () => {
    expect(submitErrorText(500, { error: "We couldn't save your submission, and nothing was kept.", attempt_id: 'att_x1' }))
      .toBe("We couldn't save your submission, and nothing was kept. Reference: att_x1");
  });

  it('falls back to a plain sentence when the server sent no message', () => {
    expect(submitErrorText(502, {})).toBe('The server returned an error (HTTP 502). Please try again.');
  });

  it('leaves out the reference when there is none', () => {
    expect(submitErrorText(400, { error: 'missing file' })).toBe('missing file');
  });
});
