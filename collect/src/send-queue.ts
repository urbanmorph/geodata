// Sends the offline capture queue (outbox.ts) from the page: Turnstile needs a
// real page, so this can't run in the service worker. It runs when a point is
// saved, when collect opens and when the signal comes back.
import { api } from './api';
import { turnstileToken } from './turnstile';
import { rememberRecord } from './maps-store';
import { flush, idbOutbox, newClientId, sendBody, type QueuedPoint, type SendResult, type FlushResult } from './outbox';

export const OUTBOX_CHANGED = 'collect:outbox-changed';
/** What changed: points the server now has (with their edit links), or ones discarded. */
export interface OutboxChange { sent: { client_id: string; link: string }[]; discarded: string[] }
const changed = (detail: Partial<OutboxChange> = {}): void =>
  void window.dispatchEvent(new CustomEvent<OutboxChange>(OUTBOX_CHANGED, { detail: { sent: [], discarded: [], ...detail } }));

async function send(p: QueuedPoint): Promise<SendResult> {
  try {
    const turnstile_token = await turnstileToken();
    const res = await api(`/collections/${p.collection_id}/records`, p.token, {
      method: 'POST',
      body: sendBody(p, turnstile_token),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; edit_token?: string; error?: string };
    if (res.ok && body.id && body.edit_token) return { ok: true, id: body.id, status: body.status ?? '', edit_token: body.edit_token };
    // 401 here means the collect link stopped working, usually because the map's owner turned it off.
    const error = res.status === 401 ? 'this collect link no longer works; the map owner may have turned it off' : body.error || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error };
  } catch {
    return { ok: false, status: 0, error: 'no connection' };
  }
}

export const editLink = (collectionId: string, recordId: string, editToken: string): string =>
  `${location.origin}/c/${collectionId}/r/${recordId}#${editToken}`;

/** Sends what's waiting; each sent point's edit link joins "Your additions". */
export async function sendQueued(): Promise<FlushResult> {
  const r = await flush(idbOutbox, send);
  const sent = r.sent.map(({ point, result }) => {
    const link = editLink(point.collection_id, result.id, result.edit_token);
    rememberRecord(point.collection_id, point.map_name, { id: result.id, label: point.label, link });
    return { client_id: point.client_id, link };
  });
  changed({ sent });
  return r;
}

export type Saved =
  | { state: 'sent'; link: string }
  | { state: 'waiting'; client_id: string }
  | { state: 'refused'; error: string };

/** Keeps a new point on the phone, then tries to send it straight away. */
export async function savePoint(p: Omit<QueuedPoint, 'client_id' | 'created_at'>): Promise<Saved> {
  const point: QueuedPoint = { ...p, client_id: newClientId(), created_at: new Date().toISOString() };
  await idbOutbox.put(point);
  const r = await sendQueued();
  const sent = r.sent.find((s) => s.point.client_id === point.client_id);
  if (sent) return { state: 'sent', link: editLink(point.collection_id, sent.result.id, sent.result.edit_token) };
  const kept = (await idbOutbox.all()).find((q) => q.client_id === point.client_id);
  if (kept?.error) {
    // Refused on the spot (e.g. the link was turned off): the form is still open,
    // so say why there instead of keeping a copy that can never be sent.
    await idbOutbox.delete(point.client_id);
    changed({ discarded: [point.client_id] });
    return { state: 'refused', error: kept.error };
  }
  return { state: 'waiting', client_id: point.client_id };
}

/** Points kept on this phone: one map's, or every map's. */
export async function queuedFor(collectionId?: string): Promise<QueuedPoint[]> {
  return (await idbOutbox.all()).filter((p) => !collectionId || p.collection_id === collectionId);
}

export async function discardQueued(clientId: string): Promise<void> {
  await idbOutbox.delete(clientId);
  changed({ discarded: [clientId] });
}

let watching = false;
/** Sends now and again whenever the signal comes back. */
export function sendWhenOnline(): void {
  void sendQueued();
  if (watching) return;
  watching = true;
  window.addEventListener('online', () => void sendQueued());
}
