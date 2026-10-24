// The model's notes on a point, as the reviewer sees them in Manage: what it
// says the photo shows and the answers it suggests, next to the collector's.
// A suggestion only fills a blank; where it differs from what the collector
// wrote, the difference is highlighted, never changed.
import { escapeHtml } from './util';
import type { Field } from './schema/validate-record';

export interface Notes {
  status: string;
  reason?: string;
  model?: string;
  description?: string;
  tags?: string[];
  answers?: Record<string, unknown>;
  tries?: number;
  review?: string;
}

const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const blank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown): boolean => show(a) === show(b);
const modelName = (m?: string): string => (m ? m.split('/').pop()! : 'a model');

export function aiNotesHtml(n: Notes | null, fields: Field[], props: Record<string, unknown>, mode: string, status: string): string {
  if (!n) return '';
  const head = (extra = ''): string => `<div class="ai-head"><strong>From the photo</strong><span class="hint">${escapeHtml(extra)}</span></div>`;
  if (n.status === 'queued' || n.status === 'running') return `<section class="ai-notes">${head()}<p class="hint">Notes from the photo are on their way.</p></section>`;
  if (n.status === 'waiting') {
    return `<section class="ai-notes">${head()}<p class="hint">${n.reason === 'daily'
      ? "Notes from the photo resume tomorrow: today's free allowance is used up."
      : 'Notes from the photo will come once the model can be reached.'}</p></section>`;
  }
  if (n.status === 'failed') return `<section class="ai-notes">${head()}<p class="hint">The model couldn't read this photo${n.tries && n.tries < 3 ? '; it will try again' : ''}.</p></section>`;

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const rows = Object.entries(n.answers ?? {}).filter(([k]) => byKey.has(k)).map(([k, v]) => {
    const mine = props[k];
    const verdict = blank(mine) ? '<span class="hint">would fill a blank</span>'
      : same(mine, v) ? '<span class="ok">✓ matches</span>'
      : `<span class="ai-diff">Collector: ${escapeHtml(show(mine))}</span>`;
    return `<div class="attr"><span class="attr__k">${escapeHtml(byKey.get(k)!.label)}</span><span class="attr__v">${escapeHtml(show(v))} ${verdict}</span></div>`;
  }).join('');
  const tags = (n.tags ?? []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');

  if (n.review) {
    return `<section class="ai-notes">${head(modelName(n.model))}
      <p class="${n.review === 'accepted' ? 'ok' : 'hint'}">${n.review === 'accepted' ? '✓ Accepted' : 'Discarded'}</p>
      ${n.review === 'accepted' ? `<p>${escapeHtml(n.description ?? '')}</p>${tags ? `<div class="row">${tags}</div>` : ''}` : ''}
    </section>`;
  }
  const approveFirst = mode === 'photos_ai' && status === 'pending';
  return `<section class="ai-notes">${head(modelName(n.model))}
    <label for="ai-desc">What the photo shows</label>
    <textarea id="ai-desc" maxlength="300">${escapeHtml(n.description ?? '')}</textarea>
    ${tags ? `<div class="row">${tags}</div>` : ''}
    ${rows ? `<div class="attrs">${rows}</div>` : '<p class="hint">No answers it could tell from the photo.</p>'}
    <div class="row" style="margin-top:8px">
      <button type="button" id="ai-discard">Discard notes</button>
      ${approveFirst
        ? '<button type="button" id="ai-accept">Accept, approve later</button><button type="button" class="primary" id="ai-approve" style="flex:1">✓ Looks right, approve</button>'
        : '<button type="button" class="primary" id="ai-accept" style="flex:1">Accept notes</button>'}
    </div>
  </section>`;
}
