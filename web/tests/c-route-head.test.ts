// Link checkers and crawlers send HEAD; /c/<id> answered 405.
import { describe, it, expect } from 'vitest';
import * as route from '../functions/c/[id]';

describe('/c/<id> methods', () => {
  it('answers HEAD like GET', () => {
    expect((route as Record<string, unknown>).onRequestHead).toBe(route.onRequestGet);
  });
});
