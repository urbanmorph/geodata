// Registers the offline worker (public/sw.js): with no connection, pages show the
// site's own offline page instead of the browser's error. bharatlas still needs the
// network for its maps and data; nothing else is cached.
export function registerOfflinePage(nav: Navigator = navigator): void {
  if (!('serviceWorker' in nav)) return;
  nav.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
}
