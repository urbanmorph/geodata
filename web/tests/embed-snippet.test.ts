import { describe, it, expect } from 'vitest';
import { embedIframeHtml, isEmbedPath, isViewPath, urlAfterCloseMap } from '../src/embed-snippet';

describe('embed-snippet — embedIframeHtml', () => {
  it('emits a sane iframe snippet with the encoded layer id', () => {
    const html = embedIframeHtml('lgd_states', 'https://bharatlas.com');
    expect(html).toMatch(/^<iframe /);
    expect(html).toContain('src="https://bharatlas.com/embed/lgd_states"');
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="520"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('allowfullscreen');
  });

  it('URL-encodes spicy ids in the src', () => {
    expect(embedIframeHtml('wards@chennai', 'https://x')).toContain('src="https://x/embed/wards%40chennai"');
  });
});

describe('embed-snippet — isEmbedPath', () => {
  it('recognises /embed/<id>', () => {
    expect(isEmbedPath('/embed/lgd_villages')).toEqual({ embed: true, layerId: 'lgd_villages' });
  });

  it('recognises a trailing slash', () => {
    expect(isEmbedPath('/embed/lgd_villages/')).toEqual({ embed: true, layerId: 'lgd_villages' });
  });

  it('decodes URI-encoded ids', () => {
    expect(isEmbedPath('/embed/wards%40chennai')).toEqual({ embed: true, layerId: 'wards@chennai' });
  });

  it('rejects bare /embed', () => {
    expect(isEmbedPath('/embed')).toEqual({ embed: false });
    expect(isEmbedPath('/embed/')).toEqual({ embed: false });
  });

  it('rejects unrelated paths', () => {
    expect(isEmbedPath('/about')).toEqual({ embed: false });
    expect(isEmbedPath('/')).toEqual({ embed: false });
  });

  it('rejects nested paths under /embed/<id>/something', () => {
    expect(isEmbedPath('/embed/lgd_villages/extra')).toEqual({ embed: false });
  });
});

describe('isViewPath', () => {
  it('recognises /view/<id>', () => {
    expect(isViewPath('/view/lgd_villages')).toEqual({ view: true, layerId: 'lgd_villages' });
  });
  it('recognises a trailing slash', () => {
    expect(isViewPath('/view/lgd_villages/')).toEqual({ view: true, layerId: 'lgd_villages' });
  });
  it('decodes URI-encoded ids', () => {
    expect(isViewPath('/view/wards%40chennai')).toEqual({ view: true, layerId: 'wards@chennai' });
  });
  it('rejects bare /view + nested paths + unrelated routes', () => {
    expect(isViewPath('/view')).toEqual({ view: false });
    expect(isViewPath('/view/')).toEqual({ view: false });
    expect(isViewPath('/view/lgd_villages/extra')).toEqual({ view: false });
    expect(isViewPath('/about')).toEqual({ view: false });
  });
});

describe('urlAfterCloseMap', () => {
  // Decides what the URL should become when the user closes the map overlay.
  // Three call-sites all funnel through here so the URL-bar always matches
  // what the user is looking at (catalog).
  it('strips a #view/<id> hash but keeps the original path + query', () => {
    // Hash-based: user was on / and clicked a card that opened map via hash.
    expect(urlAfterCloseMap('/', '#view/lgd_states', '')).toBe('/');
    expect(urlAfterCloseMap('/', '#view/lgd_states', '?foo=1')).toBe('/?foo=1');
  });
  it('returns to / when closing a /view/<id> path (the back-button URL bug)', () => {
    // Path-based: user landed at /view/<id> via shared link or clicked View
    // map → on the home page (anchor navigation). Without this, the URL bar
    // stays at /view/<id> while the displayed page is the catalog.
    expect(urlAfterCloseMap('/view/lgd_states', '', '')).toBe('/');
    expect(urlAfterCloseMap('/view/soi_subdistricts', '', '')).toBe('/');
  });
  it('preserves the query string on path-close so deep links survive', () => {
    expect(urlAfterCloseMap('/view/lgd_states', '', '?embed=1')).toBe('/?embed=1');
  });
  it('returns unchanged for non-view paths (defensive no-op)', () => {
    expect(urlAfterCloseMap('/', '', '')).toBe('/');
    expect(urlAfterCloseMap('/about', '', '?q=1')).toBe('/about?q=1');
  });
});
