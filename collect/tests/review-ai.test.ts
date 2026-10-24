// What the reviewer sees of the model's notes on a point.
import { describe, it, expect } from 'vitest';
import { aiNotesHtml } from '../src/review-ai';
import type { Field } from '../src/schema/validate-record';

const fields: Field[] = [
  { key: 'pic', label: 'Photo', type: 'photo' },
  { key: 'kind', label: 'Kind', type: 'select', options: ['Plastic', 'Debris'] },
  { key: 'size', label: 'Size', type: 'select', options: ['Small', 'Large'] },
  { key: 'note', label: 'Note', type: 'text' },
];
const done = { status: 'done', model: '@cf/google/gemma-4-26b-a4b-it', description: 'Bags by a <wall>.', tags: ['plastic'], answers: { kind: 'Plastic', size: 'Large', note: 'by the stop' } };

describe('notes from the photo, for the reviewer', () => {
  it('says nothing for a point without notes', () => {
    expect(aiNotesHtml(null, fields, {}, 'form_ai', 'pending')).toBe('');
  });

  it('says when notes are still to come, and why', () => {
    expect(aiNotesHtml({ status: 'queued' }, fields, {}, 'form_ai', 'pending')).toMatch(/on their way/);
    expect(aiNotesHtml({ status: 'waiting', reason: 'daily' }, fields, {}, 'form_ai', 'pending')).toMatch(/resume tomorrow/);
    expect(aiNotesHtml({ status: 'failed', tries: 3 }, fields, {}, 'form_ai', 'pending')).toMatch(/couldn't read/);
  });

  it("shows the suggestions, highlighting where they differ from the collector's answers", () => {
    const html = aiNotesHtml(done, fields, { kind: 'Debris', size: 'Large' }, 'form_ai', 'pending');
    expect(html).toContain('Bags by a &lt;wall&gt;.');
    expect(html).toContain('gemma-4-26b-a4b-it');
    expect(html).toMatch(/ai-diff[^]*Collector: Debris/);
    expect(html).toMatch(/Size[^]*matches/);
    expect(html).toMatch(/Note[^]*would fill a blank/);
    expect(html).toContain('id="ai-accept"');
    expect(html).toContain('id="ai-discard"');
    expect(html).not.toContain('ai-approve');
  });

  it('offers "Looks right, approve" for a pending point filled from its photo', () => {
    expect(aiNotesHtml(done, fields, {}, 'photos_ai', 'pending')).toContain('id="ai-approve"');
    expect(aiNotesHtml(done, fields, {}, 'photos_ai', 'published')).not.toContain('id="ai-approve"');
  });

  it('shows the outcome once checked', () => {
    expect(aiNotesHtml({ ...done, review: 'accepted' }, fields, {}, 'form_ai', 'pending')).toMatch(/Accepted/);
    expect(aiNotesHtml({ ...done, review: 'discarded' }, fields, {}, 'form_ai', 'pending')).toMatch(/Discarded/);
  });
});
