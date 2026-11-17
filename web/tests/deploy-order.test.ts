// Two merges close together started two deploys at once; the older build
// finished last and replaced the newer one (2026-11-17, #269 then #270). Each
// deploying workflow queues its runs per branch, so the newest commit deploys last.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const wf of ['ci.yml', 'collect.yml']) {
  describe(wf, () => {
    const y = readFileSync(resolve(__dirname, '../../.github/workflows', wf), 'utf8');
    it('runs one at a time per branch, never cancelling a deploy mid-way', () => {
      expect(y).toMatch(/\nconcurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/);
    });
  });
}
