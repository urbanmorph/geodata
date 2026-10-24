// Notes from a point's photo, written by a model on Cloudflare Workers AI after
// the photo reaches the server (never while the collector waits). The model
// suggests a one-line description, a few tags, and answers to the map's choice
// and short-text questions (never numbers). Its notes are kept in records.ai,
// apart from the point's answers, until a person accepts or discards them.
//
// The model is set in one place (AI_MODEL, or the env override) and recorded
// with every note, so moving to a newer model is a one-line change.
import type { Env } from '../types';
import { bad, json } from './http';
import { bearer, permissionFor, atLeast } from './auth';
import * as db from './db';
import { photoIdsIn, firstPhotoBytes } from './photos';
import { modeOf, usesAi, aiFillable } from '../../src/schema/modes';
import { validateRecordProperties, type Field } from '../../src/schema/validate-record';

export const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const DEFAULT_DAILY_PHOTOS = 600; // ~12 neurons a photo keeps this inside the free 10,000 a day
const MAX_TRIES = 3;
const MAX_DESCRIPTION = 300;
const MAX_TAGS = 6;

export interface AiNotes {
  status: 'queued' | 'waiting' | 'done' | 'failed';
  reason?: 'daily' | 'unavailable';
  model?: string;
  at?: string;
  description?: string;
  tags?: string[];
  answers?: Record<string, unknown>;
  tries?: number;
  error?: string;
  review?: 'accepted' | 'discarded';
  reviewed_at?: string;
}

const modelOf = (env: Env) => env.AI_MODEL || AI_MODEL;
const today = () => new Date().toISOString().slice(0, 10);

// ---- what the model is asked ------------------------------------------------------

export function aiQuestions(fields: Field[]): Field[] {
  return fields.filter(aiFillable);
}

export function aiPrompt(fields: Field[], map: { name: string; purpose: string }): string {
  const qs = aiQuestions(fields).map((f) => {
    const kind = f.type === 'select' ? `pick one of: ${f.options!.map((o) => JSON.stringify(o)).join(', ')}`
      : f.type === 'multiselect' ? `pick any of: ${f.options!.map((o) => JSON.stringify(o)).join(', ')}`
      : 'a few words';
    return `- "${f.key}": ${f.label}${f.hint ? ` (${f.hint})` : ''}; ${kind}`;
  });
  return [
    `This photo was taken for a community map: "${map.name}". What the map is for: ${map.purpose}`,
    'Describe what the photo shows in one plain sentence (at most 25 words), and give up to 5 short lowercase tags.',
    qs.length ? `Answer these questions from what is visible. Leave out any you can't tell from the photo:\n${qs.join('\n')}` : '',
    'Reply as JSON: {"description": "...", "tags": ["..."], "answers": {"question key": answer}}.',
  ].filter(Boolean).join('\n\n');
}

function aiSchema(fields: Field[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const f of aiQuestions(fields)) {
    answers[f.key] = f.type === 'select' ? { type: 'string', enum: f.options }
      : f.type === 'multiselect' ? { type: 'array', items: { type: 'string', enum: f.options } }
      : { type: 'string' };
  }
  return {
    type: 'object',
    properties: {
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      answers: { type: 'object', properties: answers },
    },
    required: ['description'],
  };
}

// ---- what the model said, kept only where it fits ------------------------------------

/** The model's answers, only for questions it may answer and only allowed values. */
export function cleanAnswers(fields: Field[], raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const f of aiQuestions(fields)) {
    const v = src[f.key];
    if (f.type === 'select' && typeof v === 'string' && f.options!.includes(v)) out[f.key] = v;
    else if (f.type === 'multiselect' && Array.isArray(v)) {
      const picked = [...new Set(v.filter((x): x is string => typeof x === 'string' && f.options!.includes(x)))];
      if (picked.length) out[f.key] = picked;
    } else if (f.type === 'text' && typeof v === 'string' && v.trim()) out[f.key] = v.trim().slice(0, Math.min(f.maxLength ?? 200, 200));
  }
  return out;
}

const cleanText = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION) : '');
const cleanTags = (v: unknown): string[] => (Array.isArray(v)
  ? [...new Set(v.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS)
  : []);

/** The reply text (or object) → notes. Tolerates a ```json fence around it. */
export function parseReply(reply: unknown, fields: Field[]): Pick<AiNotes, 'description' | 'tags' | 'answers'> {
  let obj: unknown = reply;
  if (typeof reply === 'string') {
    const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { obj = JSON.parse(text); } catch { obj = { description: text }; }
  }
  const o = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  return { description: cleanText(o.description), tags: cleanTags(o.tags), answers: cleanAnswers(fields, o.answers) };
}

function replyContent(out: unknown): unknown {
  const o = out as { choices?: Array<{ message?: { content?: unknown } }>; response?: unknown };
  return o?.choices?.[0]?.message?.content ?? o?.response ?? '';
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- running it ------------------------------------------------------------------------

/** Take one photo from today's allowance; false when it's used up. */
async function takeSlot(env: Env): Promise<boolean> {
  const limit = Number(env.AI_DAILY_PHOTOS) >= 0 && env.AI_DAILY_PHOTOS !== undefined ? Number(env.AI_DAILY_PHOTOS) : DEFAULT_DAILY_PHOTOS;
  if (limit <= 0) return false;
  const r = await env.DB.prepare(
    `INSERT INTO collect_ai_usage (day, calls) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`,
  ).bind(today(), limit).run();
  return (r.meta?.changes ?? 0) > 0;
}

const saveNotes = (env: Env, id: string, notes: AiNotes) =>
  env.DB.prepare('UPDATE records SET ai = ? WHERE id = ?').bind(JSON.stringify(notes), id).run();

/** Ask the model about one point's first photo, and keep what it says. */
export async function runAi(env: Env, recordId: string): Promise<void> {
  const r = await db.getRecord(env.DB, recordId);
  if (!r) return;
  const c = await db.getCollection(env.DB, r.collection_id);
  if (!c) return;
  const schema = JSON.parse(c.schema_doc) as { fields: Field[]; mode?: string };
  if (!usesAi(modeOf(schema))) return;
  const props = JSON.parse(r.properties) as Record<string, unknown>;
  const ids = photoIdsIn(schema.fields, props);
  if (!ids.length) return;
  const prev = (r.ai ? JSON.parse(r.ai) : {}) as AiNotes;
  if (prev.status === 'done' || prev.review) return;

  if (!env.AI) return void (await saveNotes(env, recordId, { status: 'waiting', reason: 'unavailable', tries: prev.tries }));
  if (!(await takeSlot(env))) return void (await saveNotes(env, recordId, { status: 'waiting', reason: 'daily', tries: prev.tries }));
  try {
    const bytes = await firstPhotoBytes(env, recordId, ids[0]);
    if (!bytes) throw new Error('photo not found');
    const model = modelOf(env);
    const out = await env.AI.run(model as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: 'You describe photos taken for community maps in India. Say only what is visible. Never guess about people.' },
        { role: 'user', content: [
          { type: 'text', text: aiPrompt(schema.fields, c) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64(bytes)}` } },
        ] },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'photo_notes', schema: aiSchema(schema.fields) } },
      max_tokens: 400,
    } as never);
    await saveNotes(env, recordId, { status: 'done', model, at: new Date().toISOString(), ...parseReply(replyContent(out), schema.fields) });
  } catch (e) {
    await saveNotes(env, recordId, { status: 'failed', tries: (prev.tries ?? 0) + 1, error: String((e as Error).message || e).slice(0, 200) });
  }
}

/** Points whose notes are still to come (queued, waiting for the allowance, or
 *  failed fewer than MAX_TRIES times): a few at a time, oldest first. */
export async function drainAi(env: Env, collectionId: string, max = 3): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM records WHERE collection_id = ? AND ai IS NOT NULL
       AND (json_extract(ai, '$.status') IN ('queued', 'waiting')
            OR (json_extract(ai, '$.status') = 'failed' AND COALESCE(json_extract(ai, '$.tries'), 0) < ?))
     ORDER BY created_at LIMIT ?`,
  ).bind(collectionId, MAX_TRIES, max).all<{ id: string }>();
  for (const { id } of results) await runAi(env, id);
}

/** What others may see of a point's notes: only accepted ones. */
export function publicNotes(raw: string | null): { description: string; tags: string[]; model: string } | null {
  const n = raw ? (JSON.parse(raw) as AiNotes) : null;
  if (!n || n.review !== 'accepted') return null;
  return { description: n.description ?? '', tags: n.tags ?? [], model: n.model ?? '' };
}

// ---- POST /records/:id/ai — a person accepts or discards the notes ----------------------

export async function reviewAi(env: Env, req: Request, recordId: string): Promise<Response> {
  const r = await db.getRecord(env.DB, recordId);
  if (!r) return bad(404, 'not found');
  if (!atLeast(await permissionFor(env.DB, r.collection_id, bearer(req)), 'admin')) return bad(401, 'unauthorised');
  const c = await db.getCollection(env.DB, r.collection_id);
  if (!c) return bad(404, 'not found');
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad(400, 'invalid JSON body'); }
  const notes = (r.ai ? JSON.parse(r.ai) : null) as AiNotes | null;
  if (!notes || notes.status !== 'done') return bad(409, 'no notes from the photo yet');
  const reviewed_at = new Date().toISOString();

  if (body.action === 'discard') {
    await saveNotes(env, recordId, { ...notes, review: 'discarded', reviewed_at });
    return json(200, { id: recordId, review: 'discarded' });
  }
  if (body.action !== 'accept') return bad(400, 'action must be accept or discard');

  const schema = JSON.parse(c.schema_doc) as { fields: Field[]; mode?: string };
  const props = JSON.parse(r.properties) as Record<string, unknown>;
  const answers = body.answers !== undefined ? cleanAnswers(schema.fields, body.answers) : notes.answers ?? {};
  const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  // The collector's answers are never changed: the notes only fill blanks.
  const merged = { ...props };
  for (const [k, v] of Object.entries(answers)) if (blank(merged[k])) merged[k] = v;
  const approve = body.approve === true;
  const valid = validateRecordProperties(schema.fields, merged, { photosOnly: !approve && modeOf(schema) === 'photos_ai' });
  if (!valid.ok) return bad(400, approve ? `${valid.error} before approving` : valid.error);
  const hiddenKept = Object.fromEntries(schema.fields.filter((f) => f.deleted && props[f.key] !== undefined).map((f) => [f.key, props[f.key]]));

  await db.updateRecord(env.DB, recordId, { properties: JSON.stringify({ ...hiddenKept, ...valid.properties }), ...(approve ? { status: 'published' } : {}) });
  await saveNotes(env, recordId, {
    ...notes, review: 'accepted', reviewed_at,
    description: body.description !== undefined ? cleanText(body.description) : notes.description,
    tags: body.tags !== undefined ? cleanTags(body.tags) : notes.tags,
    answers,
  });
  return json(200, { id: recordId, review: 'accepted', status: approve ? 'published' : r.status, properties: valid.properties });
}
