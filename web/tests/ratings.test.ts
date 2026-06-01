import { describe, it, expect } from 'vitest';
import { recordVote, countVotes, getMyVote, countAllUpVotes } from '../functions/lib/ratings';

type Row = { submission_id: string; ip_hash: string; created_at: string; vote: 1 | -1 };

function fakeD1() {
  const rows = new Map<string, Row>();
  const key = (s: string, i: string) => `${s}|${i}`;
  return {
    rows,
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async run() {
          if (/INSERT OR REPLACE INTO submission_ratings/.test(sql)) {
            const [submission_id, ip_hash, created_at, vote] = args as [string, string, string, 1 | -1];
            rows.set(key(submission_id, ip_hash), { submission_id, ip_hash, created_at, vote });
          } else if (/DELETE FROM submission_ratings/.test(sql)) {
            const [submission_id, ip_hash] = args as [string, string];
            rows.delete(key(submission_id, ip_hash));
          }
          return { success: true };
        },
        async first() {
          if (/SELECT vote FROM submission_ratings WHERE submission_id/.test(sql)) {
            const [submission_id, ip_hash] = args as [string, string];
            const r = rows.get(key(submission_id, ip_hash));
            return r ? { vote: r.vote } : null;
          }
          if (/SELECT[\s\S]*FROM submission_ratings WHERE submission_id =/.test(sql)) {
            const [submission_id] = args as [string];
            let up = 0;
            let down = 0;
            for (const r of rows.values()) {
              if (r.submission_id !== submission_id) continue;
              if (r.vote === 1) up++;
              else if (r.vote === -1) down++;
            }
            return { up, down };
          }
          return null;
        },
        async all() {
          if (/SELECT submission_id,\s*COUNT\(\*\)[\s\S]*FROM submission_ratings WHERE vote = 1/.test(sql)) {
            const tally = new Map<string, number>();
            for (const r of rows.values()) if (r.vote === 1) tally.set(r.submission_id, (tally.get(r.submission_id) || 0) + 1);
            return { results: [...tally.entries()].map(([submission_id, up]) => ({ submission_id, up })) };
          }
          return { results: [] };
        },
      };
    },
  };
}

describe('recordVote', () => {
  it('records a first upvote', async () => {
    const db = fakeD1();
    const r = await recordVote(db as never, 'sub1', 'A', 1);
    expect(r).toEqual({ up: 1, down: 0, score: 1, myVote: 1 });
  });

  it('records a first downvote', async () => {
    const db = fakeD1();
    const r = await recordVote(db as never, 'sub1', 'A', -1);
    expect(r).toEqual({ up: 0, down: 1, score: -1, myVote: -1 });
  });

  it('switches up → down for the same IP', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    const r = await recordVote(db as never, 'sub1', 'A', -1);
    expect(r).toEqual({ up: 0, down: 1, score: -1, myVote: -1 });
  });

  it('clears the vote when vote=0', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    const r = await recordVote(db as never, 'sub1', 'A', 0);
    expect(r).toEqual({ up: 0, down: 0, score: 0, myVote: 0 });
  });

  it('aggregates votes from distinct IPs', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    await recordVote(db as never, 'sub1', 'B', 1);
    const r = await recordVote(db as never, 'sub1', 'C', -1);
    expect(r).toEqual({ up: 2, down: 1, score: 1, myVote: -1 });
  });

  it('scopes counts to the submission', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    await recordVote(db as never, 'sub2', 'A', 1);
    expect((await recordVote(db as never, 'sub1', 'B', 1)).score).toBe(2);
    expect((await recordVote(db as never, 'sub2', 'B', -1)).score).toBe(0);
  });
});

describe('countVotes', () => {
  it('returns zeros for a submission with no votes', async () => {
    const db = fakeD1();
    expect(await countVotes(db as never, 'nope')).toEqual({ up: 0, down: 0, score: 0 });
  });

  it('returns up/down/score after votes', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    await recordVote(db as never, 'sub1', 'B', 1);
    await recordVote(db as never, 'sub1', 'C', -1);
    expect(await countVotes(db as never, 'sub1')).toEqual({ up: 2, down: 1, score: 1 });
  });
});

describe('countAllUpVotes', () => {
  it('returns an empty map when no votes exist', async () => {
    const db = fakeD1();
    expect(await countAllUpVotes(db as never)).toEqual(new Map());
  });

  it('counts up votes per submission across all rows', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    await recordVote(db as never, 'sub1', 'B', 1);
    await recordVote(db as never, 'sub2', 'A', 1);
    const m = await countAllUpVotes(db as never);
    expect(m.get('sub1')).toBe(2);
    expect(m.get('sub2')).toBe(1);
  });

  it('ignores legacy down votes', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    await recordVote(db as never, 'sub1', 'B', -1);
    const m = await countAllUpVotes(db as never);
    expect(m.get('sub1')).toBe(1);
  });

  it('omits submissions with no up votes', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', -1);
    const m = await countAllUpVotes(db as never);
    expect(m.has('sub1')).toBe(false);
  });
});

describe('getMyVote', () => {
  it('returns 0 when the IP has not voted', async () => {
    const db = fakeD1();
    expect(await getMyVote(db as never, 'sub1', 'A')).toBe(0);
  });

  it('returns 1 for an upvoter', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', 1);
    expect(await getMyVote(db as never, 'sub1', 'A')).toBe(1);
  });

  it('returns -1 for a downvoter', async () => {
    const db = fakeD1();
    await recordVote(db as never, 'sub1', 'A', -1);
    expect(await getMyVote(db as never, 'sub1', 'A')).toBe(-1);
  });
});
