import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('preview.template.html — form gating', () => {
  let html = '';
  beforeAll(() => {
    html = readFileSync(resolve(__dirname, '..', 'preview.template.html'), 'utf8');
  });

  it('form does NOT carry novalidate (browser must enforce required fields)', () => {
    // novalidate disables HTML5 constraint validation. Without a
    // checkValidity() gate on the submit button, novalidate would let
    // users POST empty forms and only learn via a server 400. Native
    // browser validation gives inline tooltips on the offending field.
    expect(html).toMatch(/<form id="meta"(?![^>]*novalidate)/);
  });

  it('every "*" field carries the required attribute', () => {
    expect(html).toMatch(/<input id="f-name"[^>]*\brequired\b/);
    expect(html).toMatch(/<select id="f-cat"[^>]*\brequired\b/);
    expect(html).toMatch(/<select id="f-lic"[^>]*\brequired\b/);
    expect(html).toMatch(/<input id="f-attr"[^>]*\brequired\b/);
    expect(html).toMatch(/<input id="f-src"[^>]*\brequired\b/);
  });
});
