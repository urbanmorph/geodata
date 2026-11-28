// The "Request a layer" form on /docs (#request): posts to /api/request-layer. Nothing is paid here; the
// owner replies by email after checking the layer can be built. A search that found nothing links here with
// ?q=, which fills in the request.
type Fields = { what: string; place: string; source: string; name: string; email: string };

const MAX_Q = 200;

/** What a ?q= search fills in. */
export function prefill(search: string): { what: string; q: string } {
  const q = (new URLSearchParams(search).get('q') || '').trim().slice(0, MAX_Q);
  return { what: q, q };
}

/** The JSON body /api/request-layer reads. */
export function requestBody(f: Fields, q: string, token: string | null) {
  return { what: f.what.trim(), place: f.place.trim(), source: f.source.trim(), name: f.name.trim(),
    email: f.email.trim(), q, turnstile_token: token || '' };
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/\.?$/, '.') : s);

/** The server's answer as one message for the page. */
export function answerText(status: number, body: { reference?: string; message?: string; error?: string }) {
  if (status === 201 && body.reference) return { ok: true, text: `${body.message || 'Request received.'} Your reference: ${body.reference}` };
  if (body.error) return { ok: false, text: sentence(body.error) };
  return { ok: false, text: "We couldn't send your request. Please try again." };
}

/** Why the form can't send yet ('' when it can): no Turnstile token, so the server would refuse it. */
export function notReady(token: string | null): string {
  return token ? '' : 'The verification check is still loading. Try again in a moment.';
}

function wire(): void {
  const form = document.querySelector<HTMLFormElement>('#request-form');
  if (!form) return;
  const status = form.querySelector<HTMLElement>('#rq-status')!;
  const send = form.querySelector<HTMLButtonElement>('#rq-send')!;
  const captcha = form.querySelector<HTMLElement>('#rq-captcha')!;
  const field = (id: string) => form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#rq-${id}`)!;
  const { what, q } = prefill(location.search);
  if (what && !field('what').value) field('what').value = what;

  let token: string | null = null;
  let widget: unknown = null;
  const renderCaptcha = () => {
    // @ts-expect-error Cloudflare's global
    widget = window.turnstile?.render(captcha, { sitekey: captcha.dataset.sitekey ?? '',
      callback: (t: string) => { token = t; }, 'expired-callback': () => { token = null; } }) ?? null;
  };
  form.addEventListener('focusin', () => {
    if (widget || document.querySelector('script[data-turnstile]')) return;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.dataset.turnstile = '';
    s.onload = renderCaptcha;
    document.head.appendChild(s);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const wait = notReady(token);
    if (wait) {
      status.dataset.state = 'error';
      status.textContent = wait;
      return;
    }
    const f = { what: field('what').value, place: field('place').value, source: field('source').value,
      name: field('name').value, email: field('email').value };
    send.disabled = true;
    status.dataset.state = '';
    status.textContent = 'Sending…';
    let shown: { ok: boolean; text: string };
    try {
      const res = await fetch('/api/request-layer', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(f, q, token)) });
      shown = answerText(res.status, await res.json().catch(() => ({})));
    } catch {
      shown = answerText(0, {});
    }
    status.dataset.state = shown.ok ? 'ok' : 'error';
    status.textContent = shown.text;
    send.disabled = false;
    if (shown.ok) form.reset();
    // @ts-expect-error Cloudflare's global
    if (widget != null) window.turnstile?.reset(widget);
    token = null;
  });
}

if (typeof document !== 'undefined') wire();
