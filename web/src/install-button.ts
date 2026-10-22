// "Install app" button, shared by bharatlas.com and collect.bharatlas.com
// (collect imports this file, as it already does web's licence/token helpers).
//
//   Chrome / Edge / Samsung Internet / Android -> real install: the browser fires
//       `beforeinstallprompt`; we keep it and call prompt() on tap.
//   iPhone / iPad Safari -> no install API exists; the button opens a short
//       "Share -> Add to Home Screen" guide instead.
//   Already installed (running standalone) -> hidden.
//   Anything else (e.g. Firefox desktop, Chrome on iOS) -> hidden.
// Needs a valid web app manifest, or `beforeinstallprompt` never fires.
// Each site styles `.install-app` (the button) and `dialog.install-guide`.

import { escapeHtml } from './util';

// Not in lib.dom yet (Chromium-only).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(win: Window = window): boolean {
  return Boolean(
    win.matchMedia?.('(display-mode: standalone)').matches ||
      (win.navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
}

// iPadOS 13+ reports itself as a Mac; tell it apart by touch support. Chrome,
// Firefox, Edge and Opera on iOS are excluded: their Share sheets differ.
export function isIosSafari(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  return ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export function mountInstallButton(
  button: HTMLButtonElement | null,
  { appName = 'this app', win = window }: { appName?: string; win?: Window } = {},
): () => void {
  if (!button || isStandalone(win)) return () => {};
  let deferred: BeforeInstallPromptEvent | null = null;

  const onPrompt = (e: Event): void => {
    e.preventDefault(); // keep the browser's mini-infobar away; we offer the button instead
    deferred = e as BeforeInstallPromptEvent;
    button.hidden = false;
  };
  const onInstalled = (): void => {
    deferred = null;
    button.hidden = true;
  };
  win.addEventListener('beforeinstallprompt', onPrompt);
  win.addEventListener('appinstalled', onInstalled);

  if (isIosSafari(win.navigator)) button.hidden = false;

  button.addEventListener('click', async () => {
    if (deferred) {
      const ev = deferred;
      deferred = null; // a prompt event can only be used once
      void ev.prompt();
      const { outcome } = await ev.userChoice;
      if (outcome === 'accepted') button.hidden = true;
      return;
    }
    if (isIosSafari(win.navigator)) showIosGuide(appName, win.document);
  });

  return () => {
    win.removeEventListener('beforeinstallprompt', onPrompt);
    win.removeEventListener('appinstalled', onInstalled);
  };
}

// A small accessible modal; it removes itself when closed.
export function showIosGuide(appName: string, doc: Document = document): void {
  const dlg = doc.createElement('dialog');
  dlg.className = 'install-guide';
  dlg.setAttribute('aria-labelledby', 'install-guide-title');
  dlg.innerHTML = `
    <h2 id="install-guide-title">Add ${escapeHtml(appName)} to your Home Screen</h2>
    <ol>
      <li>Tap the <strong>Share</strong> button <span aria-hidden="true">(the square with an arrow)</span> in Safari's toolbar.</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
      <li>Tap <strong>Add</strong>.</li>
    </ol>
    <form method="dialog"><button>OK</button></form>`;
  dlg.addEventListener('close', () => dlg.remove());
  doc.body.appendChild(dlg); // not append(): @cloudflare/workers-types shadows its DOM type
  dlg.showModal();
}
