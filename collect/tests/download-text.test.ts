// @vitest-environment happy-dom
// Safari can abort a download whose object URL is revoked in the same tick
// as the click (web/src/image-export.ts defers it for the same reason).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadText } from '../src/util';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('downloadText', () => {
  it('clicks an attached link and revokes the URL only later', () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let attached = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { attached = this.isConnected; });
    downloadText('a,b', 'points.csv', 'text/csv');
    expect(create).toHaveBeenCalledTimes(1);
    expect(attached).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
