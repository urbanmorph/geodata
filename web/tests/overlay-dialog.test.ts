// @vitest-environment happy-dom
// The map overlay is a modal dialog: named by the layer title, the page behind
// it inert while open, focus moved in on open and back to the trigger on close.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDialog, closeDialog } from '../../shared/modal';

const page = () => {
  document.body.innerHTML = `
    <header id="nav"><a href="/">home</a></header>
    <main id="main"><a id="trigger" href="#view/x">View</a></main>
    <footer id="foot"></footer>
    <div id="map-overlay" role="dialog" aria-modal="true" aria-labelledby="map-title" tabindex="-1" aria-hidden="true">
      <span id="map-title">Wards</span><button id="map-close">back</button>
    </div>`;
  return document.getElementById('map-overlay')!;
};

describe('map overlay dialog', () => {
  let overlay: HTMLElement;
  beforeEach(() => { overlay = page(); });

  it('the template marks the overlay a modal dialog named by the layer title', () => {
    const html = readFileSync(resolve(__dirname, '../index.template.html'), 'utf8');
    const tag = html.match(/<div id="map-overlay"[^>]*>/)![0];
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain('aria-labelledby="map-title"');
    expect(tag).toContain('tabindex="-1"');
  });

  it('opening makes everything else inert and moves focus inside', () => {
    document.getElementById('trigger')!.focus();
    openDialog(overlay);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    for (const id of ['nav', 'main', 'foot']) expect(document.getElementById(id)!.hasAttribute('inert'), id).toBe(true);
    expect(overlay.hasAttribute('inert')).toBe(false);
    expect(overlay.contains(document.activeElement)).toBe(true);
  });

  it('closing restores the page and returns focus to the trigger', () => {
    const trigger = document.getElementById('trigger')!;
    trigger.focus();
    openDialog(overlay);
    document.getElementById('map-close')!.focus();
    closeDialog(overlay);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    for (const id of ['nav', 'main', 'foot']) expect(document.getElementById(id)!.hasAttribute('inert'), id).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('a second open (another layer) keeps the first trigger', () => {
    const trigger = document.getElementById('trigger')!;
    trigger.focus();
    openDialog(overlay);
    openDialog(overlay);
    closeDialog(overlay);
    expect(document.activeElement).toBe(trigger);
  });

  it('opened on page load (no trigger), closing leaves focus out of the hidden overlay', () => {
    openDialog(overlay);
    closeDialog(overlay);
    expect(overlay.contains(document.activeElement)).toBe(false);
  });

  it('leaves alone what was already inert', () => {
    document.getElementById('foot')!.setAttribute('inert', '');
    openDialog(overlay);
    closeDialog(overlay);
    expect(document.getElementById('foot')!.hasAttribute('inert')).toBe(true);
  });
});
