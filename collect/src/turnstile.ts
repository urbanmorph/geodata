// Solve a Turnstile token to send with create/contribute. Turnstile requires
// https, so on http/localhost (dev) we skip it — the server also skips
// verification when no secret is configured, so local testing stays clean and
// error-free. In prod (https) the invisible widget solves in the background.
import { TURNSTILE_SITEKEY } from './config';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (el: HTMLElement | string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi; }
}

export function turnstileActive(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

let loading: Promise<void> | null = null;
function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile load failed'));
    document.head.appendChild(s);
  });
  return loading;
}

export async function turnstileToken(): Promise<string> {
  if (!turnstileActive()) return ''; // dev / http — server skips verification too
  try {
    await load();
    const ts = window.turnstile!;
    return await new Promise<string>((resolve) => {
      // Off-screen (not display:none — Turnstile rejects that). Invisible-mode
      // widget solves in the background via execute().
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      el.style.bottom = '0';
      document.body.appendChild(el);
      let settled = false;
      let id = '';
      const done = (t: string) => {
        if (settled) return;
        settled = true;
        try { ts.remove(id); } catch { /* noop */ }
        el.remove();
        resolve(t);
      };
      id = ts.render(el, {
        sitekey: TURNSTILE_SITEKEY,
        callback: (t: string) => done(t),
        'error-callback': () => done(''),
        'timeout-callback': () => done(''),
      });
      ts.execute(el);
      setTimeout(() => done(''), 9000); // never hang a submit
    });
  } catch {
    return '';
  }
}
