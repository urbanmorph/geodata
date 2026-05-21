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

  it('hero copy emphasises dual purpose, not just "contribute"', () => {
    // Avoid making /preview read as a submit-only surface. "Contribute a
    // layer" implies one path; the page actually does view + verify +
    // optional publish. Keep the title view-first.
    expect(html).toContain('View, verify, or publish a geo file');
    expect(html).not.toContain('<h1 class="page-title">Contribute a layer</h1>');
  });

  it('hero sub copy makes "no upload by default" explicit', () => {
    // The previous wording — "fill in a few details" — primed users to
    // submit. Replace with copy that names the optional publish step.
    expect(html).toContain('Optionally publish to the open catalog');
    expect(html).not.toContain('fill in a few details');
  });
});
