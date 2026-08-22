import { describe, it, expect } from 'vitest';
import { deferLog } from '../functions/lib/collect-log';

// Minimal D1 stub: prepare -> bind -> run. deferLog only needs the chain to
// exist; the run() promise is what must reach `defer`.
const mockDb = () =>
  ({ prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) }) as unknown as Parameters<typeof deferLog>[1];

describe('deferLog', () => {
  it('registers the log promise with defer, so waitUntil keeps it alive (not fire-and-forget)', () => {
    // This is the regression guard: the old `void logCollectAttempt(...)` was a
    // dangling promise the runtime cancelled before the D1 write committed,
    // which is why collect_attempts stayed empty.
    const captured: Promise<unknown>[] = [];
    const defer = (p: Promise<unknown>) => {
      captured.push(p);
    };
    deferLog(defer, mockDb(), { event: 'create', outcome: 'ok', collection_id: 'abc' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeInstanceOf(Promise);
  });

  it('falls back to best-effort (never throws) when no defer is provided', () => {
    expect(() => deferLog(undefined, mockDb(), { event: 'contribute', outcome: 'ok' })).not.toThrow();
  });
});
