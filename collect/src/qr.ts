// A QR code as a scalable, dark-on-white SVG string. Used to hand a collect
// link from one screen to another (laptop -> phone camera) with no accounts and
// no server. The encoder (qrcode-generator, MIT) is dynamically imported so it
// only loads the first time a QR is shown — the lean landing bundle stays lean.
//
// Colours are fixed #000-on-#fff regardless of theme: a QR must stay dark
// modules on a light ground to scan, so this never follows prefers-color-scheme.

export async function qrSvg(text: string, opts: { margin?: number } = {}): Promise<string> {
  const qrcode = (await import('qrcode-generator')).default;
  const qr = qrcode(0, 'M'); // type 0 = auto-pick the smallest version that fits; EC level M
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const margin = opts.margin ?? 4; // 4-module quiet zone (spec minimum)
  const size = count + margin * 2;

  // One <path> of unit squares for the dark modules — compact and crisp.
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%"` +
    ` shape-rendering="crispEdges" role="img" aria-label="QR code for this link">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/></svg>`
  );
}
