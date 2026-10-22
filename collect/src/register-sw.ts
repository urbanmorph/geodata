// The offline worker (src/sw/sw.js, written by the build): the landing page and
// the map app open with no signal. Built site only; dev has no sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => { /* works online without it */ });
}
