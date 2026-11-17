import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Glama looks for /.well-known/glama.json on a hosted MCP server's domain to confirm who maintains it.
// Without the file the address answered with the home page (200), or once a 500.
describe('/.well-known/glama.json', () => {
  it('is served, and is the same as the repo-root glama.json Glama reads on GitHub', () => {
    const served = readFileSync(new URL('../public/.well-known/glama.json', import.meta.url), 'utf8');
    const root = readFileSync(new URL('../../glama.json', import.meta.url), 'utf8');
    expect(served).toBe(root);
    expect(JSON.parse(served).maintainers).toContain('sathya-sankaran');
  });
});
