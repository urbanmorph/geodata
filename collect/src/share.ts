// Moving a map's links between devices, with no accounts. The link IS the
// credential, so there is nothing to sync — instead we make the hand-off easy:
//   · shareOrCopy  — the native share sheet (AirDrop / message / mail yourself),
//                    falling back to the clipboard where share is unavailable.
//   · linksMailtoHref — mail every link to yourself; email reaches any device.
//   · a QR of a link (see qr.ts) covers laptop -> phone.
// linksText is the shared plain-text block used by both the mail body and the
// "download my links" file, so the two never drift.

export interface MapLinks {
  edit?: string;
  admin?: string;
  view?: string;
}

// Present links only, each labelled in plain words. Admin last, with a secrecy
// note when it is included. No em-dashes (public-facing copy).
export function linksText(links: MapLinks, mapName?: string): string {
  const head = mapName ? `collect.bharatlas.com links for "${mapName}"` : 'collect.bharatlas.com map links';
  const lines: string[] = [head, ''];
  if (links.edit) lines.push(`Collect link (share to add points): ${links.edit}`);
  if (links.view) lines.push(`View only: ${links.view}`);
  if (links.admin) lines.push(`Admin (keep secret, full control): ${links.admin}`);
  if (links.admin) {
    lines.push('', 'Keep the admin link private. Anyone who has it can moderate and publish this map.');
  }
  return lines.join('\n') + '\n';
}

// A mailto: to send the links to yourself (no recipient prefilled). Email is the
// natural cross-device home for a secret like the admin link.
export function linksMailtoHref(links: MapLinks, mapName?: string): string {
  const subject = mapName ? `collect map links: ${mapName}` : 'collect map links';
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(linksText(links, mapName))}`;
}

// Share one link via the native share sheet; fall back to the clipboard. Both
// must run inside the user's tap (iOS/Safari drop a share/clipboard call made
// after an await), so keep the call synchronous with the gesture at the caller.
export async function shareOrCopy(url: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title, url });
      return 'shared';
    } catch (e) {
      // AbortError = the user dismissed the sheet; treat as a no-op, not a copy.
      if (e instanceof DOMException && e.name === 'AbortError') return 'shared';
      // otherwise fall through to clipboard
    }
  }
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
    return 'failed';
  } catch {
    return 'failed';
  }
}
