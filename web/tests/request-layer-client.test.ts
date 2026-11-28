// The /docs request form's logic: a search that found nothing fills in what was searched for, the request
// body carries every field and the Turnstile token, and the server's answer becomes one plain message.
import { describe, expect, it } from 'vitest';
import { prefill, requestBody, answerText, notReady } from '../src/request-layer';

describe('request-layer form', () => {
  it('fills "what" from the search that found nothing (?q=), and nothing otherwise', () => {
    expect(prefill('?q=anganwadi%20pune')).toEqual({ what: 'anganwadi pune', q: 'anganwadi pune' });
    expect(prefill('')).toEqual({ what: '', q: '' });
    expect(prefill('?q=' + 'x'.repeat(500)).q.length).toBe(200);
  });

  it('sends every field, the search and the token', () => {
    expect(requestBody({ what: ' Schools ', place: 'Pune', source: '', name: '', email: 'a@b.in' }, 'anganwadi', 'tok'))
      .toEqual({ what: 'Schools', place: 'Pune', source: '', name: '', email: 'a@b.in', q: 'anganwadi', turnstile_token: 'tok' });
  });

  it('turns the answer into one message: the reference on success, the reason otherwise', () => {
    expect(answerText(201, { reference: 'req_abc', message: 'Request received.' }))
      .toEqual({ ok: true, text: 'Request received. Your reference: req_abc' });
    expect(answerText(400, { error: 'an email address is needed for our reply' }))
      .toEqual({ ok: false, text: 'An email address is needed for our reply.' });
    expect(answerText(500, {})).toEqual({ ok: false, text: "We couldn't send your request. Please try again." });
  });
});

describe('sending before the check is ready', () => {
  it('waits for the verification check instead of sending a request that would be refused', () => {
    expect(notReady(null)).toBe('The verification check is still loading. Try again in a moment.');
    expect(notReady('tok')).toBe('');
  });
});
