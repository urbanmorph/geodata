import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { submitErrorText, submitNetworkErrorText, urlFetchErrorText } from '../src/submit-error';

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

describe('the other failure lines are sentences', () => {
  it('a submit that never reached the server', () => {
    expect(submitNetworkErrorText(new TypeError('Failed to fetch'))).toBe(
      "Couldn't reach bharatlas (Failed to fetch). Check your connection and try again.");
  });
  it('a ?url= file that could not be fetched', () => {
    expect(urlFetchErrorText(new Error('HTTP 404'))).toBe("Couldn't fetch that file (HTTP 404).");
  });
});

// A Turnstile token is single use: after any failed submit it must be reset,
// or the next attempt sends the spent token and fails again.
describe('a failed submit resets the captcha', () => {
  it('every failure branch goes through one helper that resets Turnstile', () => {
    const src = readFileSync(resolve(__dirname, '../src/preview.ts'), 'utf8');
    const handler = src.slice(src.indexOf("form.addEventListener('submit'"), src.indexOf('function renderSuccess'));
    const fails = handler.match(/^\s+submitFailed\(/gm) || [];
    expect(fails.length).toBe(3); // network error, non-JSON reply, error status
    expect(handler).not.toMatch(/submitBtn\.disabled = false/);
    expect(src).toMatch(/function submitFailed\([^)]*\)[^{]*\{[^}]*resetCaptcha\(\)/);
  });
});
