// Solve a fresh invisible Turnstile token to send with create/contribute.
// The server verifies it when TURNSTILE_SECRET is configured (prod) and skips
// it in local dev. Returns '' if Turnstile can't load (server then decides).
import { TURNSTILE_SITEKEY } from './config';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi; }
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
  try {
    await load();
    const ts = window.turnstile!;
    return await new Promise<string>((resolve) => {
      const el = document.createElement('div');
      el.style.display = 'none';
      document.body.appendChild(el);
      let id = '';
      const done = (t: string) => { try { ts.remove(id); } catch { /* noop */ } el.remove(); resolve(t); };
      id = ts.render(el, {
        sitekey: TURNSTILE_SITEKEY,
        size: 'invisible',
        callback: (t: string) => done(t),
        'error-callback': () => done(''),
        'timeout-callback': () => done(''),
      });
      ts.execute(id);
    });
  } catch {
    return '';
  }
}
