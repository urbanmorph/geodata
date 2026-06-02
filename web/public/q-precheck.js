// Pre-paint URL state, so CSS can render the search/category-filtered
// view directly instead of main.ts mutating the DOM after hydration.
// The mutation path was producing a CLS shift attributed to
// `.category-section.expanded` (forceExpand → reveal collapsed rows).
//
// Synchronous (no defer/async) and loaded from <head> so it runs
// before first paint. The CSS rule `html.has-query .row--collapsed
// { display: block }` then matches immediately. main.ts still
// runs its full apply() later; the DOM state already matches so
// no layout-changing toggles fire.
(function () {
  try {
    if (new URLSearchParams(location.search).get('q')) {
      document.documentElement.classList.add('has-query');
    }
  } catch (_e) {
    // URLSearchParams is universally supported; if it ever throws,
    // skipping the class just means we get the old CLS behaviour,
    // not a broken page.
  }
})();
