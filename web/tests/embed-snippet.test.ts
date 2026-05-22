import { describe, it, expect } from 'vitest';
import { embedIframeHtml, isEmbedPath, isViewPath } from '../src/embed-snippet';

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
