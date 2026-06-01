// Vote button wiring for /c/<id>. Loaded as a same-origin module so the
// strict CSP (script-src 'self' …, no 'unsafe-inline') doesn't block it
// the way the inline <script> body did. Behaviour unchanged: single-
// direction "Useful" vote, click toggles between marked and cleared.
//
// Body must carry data-submission-id="<id>"; the page template sets that.
(() => {
  const id = document.body.dataset.submissionId;
  const btn = document.getElementById('vote-useful');
  const count = document.getElementById('vote-count');
  if (!id || !btn || !count) return;

  let myVote = 0;
  const apply = (s) => {
    count.textContent = String(s.up || 0);
    myVote = s.myVote === 1 ? 1 : 0;
    btn.setAttribute('aria-pressed', myVote === 1 ? 'true' : 'false');
  };

  fetch('/api/c/' + id + '/rate').then((r) => r.ok ? r.json() : null).then((s) => s && apply(s)).catch(() => {});

  const send = async (vote) => {
    btn.disabled = true;
    try {
      const r = await fetch('/api/c/' + id + '/rate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vote }),
      });
      if (r.ok) apply(await r.json());
    } catch {}
    btn.disabled = false;
  };
  btn.addEventListener('click', () => send(myVote === 1 ? 0 : 1));
})();
