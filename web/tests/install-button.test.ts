// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isStandalone, isIosSafari, mountInstallButton, showIosGuide } from '../src/install-button';

// Shared by bharatlas.com and collect.bharatlas.com (collect imports this file).

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  ipadOsAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

type FakeNav = { userAgent: string; maxTouchPoints?: number; standalone?: boolean };

// A fake window: a real EventTarget (so dispatchEvent works) plus the bits the
// component reads. `standalone` drives matchMedia('(display-mode: standalone)').
function fakeWin(nav: FakeNav, { standalone = false } = {}): Window {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  t.navigator = nav;
  t.document = document;
  t.matchMedia = (q: string) => ({ matches: standalone && q === '(display-mode: standalone)' });
  return t as unknown as Window;
}

function promptEvent(outcome: 'accepted' | 'dismissed') {
  const ev = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  ev.prompt = vi.fn(async () => undefined);
  ev.userChoice = Promise.resolve({ outcome });
  return ev;
}

function newButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.hidden = true;
  document.body.append(b);
  return b;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  // happy-dom's dialog: make showModal observable without relying on its implementation.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
});

describe('isStandalone', () => {
  it('is true when display-mode is standalone', () => {
    expect(isStandalone(fakeWin({ userAgent: UA.androidChrome }, { standalone: true }))).toBe(true);
  });
  it('is true for iOS home-screen apps (navigator.standalone)', () => {
    expect(isStandalone(fakeWin({ userAgent: UA.iphoneSafari, standalone: true }))).toBe(true);
  });
  it('is false in a normal browser tab', () => {
    expect(isStandalone(fakeWin({ userAgent: UA.androidChrome }))).toBe(false);
  });
  it('is false when matchMedia is missing', () => {
    const w = fakeWin({ userAgent: UA.androidChrome }) as unknown as Record<string, unknown>;
    delete w.matchMedia;
    expect(isStandalone(w as unknown as Window)).toBe(false);
  });
});

describe('isIosSafari', () => {
  it('detects iPhone Safari', () => {
    expect(isIosSafari({ userAgent: UA.iphoneSafari } as Navigator)).toBe(true);
  });
  it('detects iPadOS reporting as a Mac (touch points > 1)', () => {
    expect(isIosSafari({ userAgent: UA.ipadOsAsMac, maxTouchPoints: 5 } as Navigator)).toBe(true);
  });
  it('ignores a real Mac (no touch)', () => {
    expect(isIosSafari({ userAgent: UA.ipadOsAsMac, maxTouchPoints: 0 } as Navigator)).toBe(false);
  });
  it('excludes Chrome (CriOS) and Firefox (FxiOS) on iOS', () => {
    expect(isIosSafari({ userAgent: UA.iphoneChrome } as Navigator)).toBe(false);
    expect(isIosSafari({ userAgent: UA.iphoneFirefox } as Navigator)).toBe(false);
  });
  it('is false on Android', () => {
    expect(isIosSafari({ userAgent: UA.androidChrome } as Navigator)).toBe(false);
  });
});

describe('mountInstallButton', () => {
  it('tolerates a missing button', () => {
    expect(() => mountInstallButton(null, { win: fakeWin({ userAgent: UA.androidChrome }) })).not.toThrow();
  });

  it('stays hidden until the browser offers an install prompt', () => {
    const win = fakeWin({ userAgent: UA.androidChrome });
    const b = newButton();
    mountInstallButton(b, { win });
    expect(b.hidden).toBe(true);
    const ev = promptEvent('accepted');
    win.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // our button replaces the mini-infobar
    expect(b.hidden).toBe(false);
  });

  it('calls prompt() on tap and hides once accepted', async () => {
    const win = fakeWin({ userAgent: UA.androidChrome });
    const b = newButton();
    mountInstallButton(b, { win });
    const ev = promptEvent('accepted');
    win.dispatchEvent(ev);
    b.click();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await flush();
    expect(b.hidden).toBe(true);
  });

  it('stays visible when the prompt is dismissed, but the spent event is not reused', async () => {
    const win = fakeWin({ userAgent: UA.androidChrome });
    const b = newButton();
    mountInstallButton(b, { win });
    const ev = promptEvent('dismissed');
    win.dispatchEvent(ev);
    b.click();
    await flush();
    expect(b.hidden).toBe(false);
    b.click();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
  });

  it('hides after appinstalled', () => {
    const win = fakeWin({ userAgent: UA.androidChrome });
    const b = newButton();
    mountInstallButton(b, { win });
    win.dispatchEvent(promptEvent('accepted'));
    win.dispatchEvent(new Event('appinstalled'));
    expect(b.hidden).toBe(true);
  });

  it('never shows when already running installed', () => {
    const win = fakeWin({ userAgent: UA.androidChrome }, { standalone: true });
    const b = newButton();
    mountInstallButton(b, { win });
    win.dispatchEvent(promptEvent('accepted'));
    expect(b.hidden).toBe(true);
  });

  it('never shows on an iOS home-screen app', () => {
    const b = newButton();
    mountInstallButton(b, { win: fakeWin({ userAgent: UA.iphoneSafari, standalone: true }) });
    expect(b.hidden).toBe(true);
  });

  it('shows on iPhone Safari and opens the Add to Home Screen guide on tap', () => {
    const b = newButton();
    mountInstallButton(b, { appName: 'collect', win: fakeWin({ userAgent: UA.iphoneSafari }) });
    expect(b.hidden).toBe(false);
    b.click();
    const dlg = document.querySelector('dialog.install-guide');
    expect(dlg).not.toBeNull();
    expect(dlg!.hasAttribute('open')).toBe(true);
    expect(dlg!.textContent).toContain('Add collect to your Home Screen');
    expect(dlg!.textContent).toContain('Add to Home Screen');
  });

  it('stays hidden on browsers with no install path (e.g. iOS Chrome, desktop Firefox)', () => {
    const b = newButton();
    mountInstallButton(b, { win: fakeWin({ userAgent: UA.iphoneChrome }) });
    expect(b.hidden).toBe(true);
    b.click();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('cleanup stops listening for install prompts', () => {
    const win = fakeWin({ userAgent: UA.androidChrome });
    const b = newButton();
    const stop = mountInstallButton(b, { win });
    stop();
    win.dispatchEvent(promptEvent('accepted'));
    expect(b.hidden).toBe(true);
  });
});

describe('showIosGuide', () => {
  it('escapes the app name and removes itself on close', () => {
    showIosGuide('<img src=x onerror=alert(1)>', document);
    const dlg = document.querySelector('dialog.install-guide')!;
    expect(dlg.querySelector('img')).toBeNull();
    expect(dlg.getAttribute('aria-labelledby')).toBe(dlg.querySelector('h2')!.id);
    dlg.dispatchEvent(new Event('close'));
    expect(document.querySelector('dialog.install-guide')).toBeNull();
  });
});
