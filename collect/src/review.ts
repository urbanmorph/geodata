// Pure review-list helpers. The admin Review tab caches every record once and
// filters/counts them in memory (a filter chip used to re-hit the network on
// each click). Kept framework-free and testable.

type WithStatus = { properties: Record<string, unknown> };

export function statusOf(f: WithStatus): string {
  const s = f.properties._status;
  return typeof s === 'string' && s ? s : 'published';
}

// The active filter's rows. Empty string is the "All" chip and returns the same
// array (no copy), so the common case is free.
export function filterByStatus<T extends WithStatus>(feats: T[], status: string): T[] {
  return status ? feats.filter((f) => statusOf(f) === status) : feats;
}

export function countsOf(feats: WithStatus[]): { published: number; pending: number; rejected: number; total: number } {
  const c = { published: 0, pending: 0, rejected: 0, total: feats.length };
  for (const f of feats) {
    const s = statusOf(f);
    if (s === 'published' || s === 'pending' || s === 'rejected') c[s]++;
  }
  return c;
}

// The "who" prefix for a record's meta line. Imported data credits its source; a
// contributor who typed a name is shown; an unnamed capture returns '' so the UI
// shows nothing — with no accounts, "by anonymous" is noise on every record.
export function recordWho(source?: string | null, contributor?: string | null): string {
  if (source && source.trim()) return `⇪ from ${source}`;
  if (contributor && contributor.trim()) return `by ${contributor}`;
  return '';
}

export type PopupAction = { act: string; label: string; cls: string };

// The moderation actions a record's map tooltip offers, by status — so an admin
// with hundreds of points can pan, tap a marker, and act on just that one
// without scrolling the list. `act` is the moderation target ('published' /
// 'rejected'), except 'open' which opens the full record (edit / delete / all
// attributes). Pending can be approved or rejected; a rejected record can be
// re-approved; an approved record has nothing left to moderate. Every record can
// be opened in full.
export function popupActions(status: string): PopupAction[] {
  const open: PopupAction = { act: 'open', label: 'Open ›', cls: 'pop-review' };
  if (status === 'pending')
    return [
      { act: 'rejected', label: '✗ Reject', cls: 'pop-btn--reject' },
      { act: 'published', label: '✓ Approve', cls: 'pop-btn--approve' },
      open,
    ];
  if (status === 'rejected') return [{ act: 'published', label: '✓ Approve', cls: 'pop-btn--approve' }, open];
  return [open];
}
