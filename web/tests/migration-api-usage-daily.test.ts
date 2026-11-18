import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 0018 api_usage_daily', () => {
  const sql = readFileSync(resolve(__dirname, '../migrations/0018_api_usage_daily.sql'), 'utf8');
  it('creates the per-day table keyed by (day, layer_id, channel), with no caller columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS api_usage_daily/);
    expect(sql).toMatch(/PRIMARY KEY \(day, layer_id, channel\)/);
    const columns = sql.replace(/--.*$/gm, '');
    expect(columns).not.toMatch(/\bip\w*|user_agent|\bua\b/i);
  });
});
