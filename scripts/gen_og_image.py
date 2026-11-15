#!/usr/bin/env python3
"""
Generate web/public/og-default.png — the 1200x630 social-card hero.

Workflow:
  1. Dissolve sources/india-geodata/LGD_States.parquet into a single
     country polygon via DuckDB-spatial (ST_Union + ST_Simplify).
  2. Project lon/lat to SVG coords with a manual equirectangular fit
     centred on India.
  3. Compose the SVG (chakra-navy bg, saffron India outline at low
     opacity, the three-layer mark, "bharatlas" wordmark, tagline, footer).
  4. Render to PNG via headless Chromium (web/scripts/render_og.mjs).

Run:
    python3 scripts/gen_og_image.py
"""
import json
import subprocess
import sys
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata' / 'LGD_States.parquet'
OUT_DIR = ROOT / 'web' / 'public'

CANVAS_W, CANVAS_H = 1200, 630

# One variant per page. Same wordmark + India silhouette; only the
# sub-tagline differs. prerender.mjs's seoHead() picks which file to point at.
VARIANTS = [
    {
        'name': 'og-default',          # home / index / fallback
        'tagline': "India's open atlas",
        'sub': 'view · verify · publish geo files',
        'footer': ('open licences', 'no signup, no tracking'),
    },
    {
        'name': 'og-preview',
        'tagline': 'View. Verify. Publish.',
        'sub': 'drop a geo file → see it on a map',
        'footer': ('open licences', 'nothing uploaded until you click Publish'),
    },
    {
        'name': 'og-about',
        'tagline': 'About bharatlas',
        'sub': "India's open visualiser, verifier + contribution flow",
        'footer': ('open source · MIT', 'made by Urban Morph'),
    },
]

# Brand colours, mirrored from shared/brand.mjs (PALETTE).
NAVY_BG = '#13265A'          # gradient end; starts at chakra navy #0B1B3F
SAFFRON = '#F28C28'          # India watermark
FG_LIGHT = '#FFFFFF'         # wordmark + tagline


def dissolve_india() -> str:
    """Return a simplified GeoJSON for the country outline."""
    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')
    # LGD state polygons have tiny gaps between neighbours because each
    # was simplified independently upstream. Plain ST_Union_Agg leaves
    # 700+ polygons (no dissolution between states). Buffer-out + union
    # + buffer-back-in is the standard trick to close the slivers.
    #   ST_MakeValid          repair self-intersections in individual states
    #   ST_Buffer(0.03)       expand by ~3 km so neighbours overlap
    #   ST_Union_Agg          merge into one (multi)polygon
    #   ST_Buffer(-0.025)     shrink back, slightly less so we don't lose coast
    #   ST_Simplify(0.05)     OG-image-scale silhouette reduction
    sql = f"""
        WITH valid AS (
          SELECT ST_Buffer(ST_MakeValid(geometry), 0.03) AS g FROM '{SRC}'
        ),
        dissolved AS (
          SELECT ST_Buffer(ST_Union_Agg(g), -0.025) AS g FROM valid
        )
        SELECT ST_AsGeoJSON(ST_Simplify(g, 0.05)) AS gj,
               ST_NumGeometries(g) AS npoly
        FROM dissolved
    """
    gj_str, npoly = con.execute(sql).fetchone()
    (n_states,) = con.execute(f"SELECT COUNT(*) FROM '{SRC}'").fetchone()
    print(f'  dissolved {n_states} states → {npoly} polygons')
    return gj_str


def project_path(geojson_str: str) -> tuple[str, tuple[float, float, float, float]]:
    """Project lon/lat coords into SVG space. Returns (path_d, bbox)."""
    geom = json.loads(geojson_str)
    coords_iter = []
    if geom['type'] == 'Polygon':
        coords_iter = [geom['coordinates']]
    elif geom['type'] == 'MultiPolygon':
        coords_iter = geom['coordinates']

    # India bbox roughly: lon 68..98, lat 6..38.
    min_lon, min_lat = 67.5, 5.5
    max_lon, max_lat = 98.5, 38
    # Fit the silhouette into a square area on the left of the canvas.
    target_w = 460
    target_h = 480
    pad_x = 90
    pad_y = (CANVAS_H - target_h) // 2

    span_lon = max_lon - min_lon
    span_lat = max_lat - min_lat
    scale = min(target_w / span_lon, target_h / span_lat)
    # Centre the geometry inside its allocated box.
    used_w = span_lon * scale
    used_h = span_lat * scale
    off_x = pad_x + (target_w - used_w) / 2
    off_y = pad_y + (target_h - used_h) / 2

    def to_svg(lon: float, lat: float) -> tuple[float, float]:
        x = off_x + (lon - min_lon) * scale
        # Invert lat (SVG y grows downward).
        y = off_y + (max_lat - lat) * scale
        return x, y

    path_parts: list[str] = []
    for polygon in coords_iter:
        for ring in polygon:
            if not ring:
                continue
            x0, y0 = to_svg(*ring[0])
            path_parts.append(f'M {x0:.1f} {y0:.1f}')
            for lon, lat in ring[1:]:
                x, y = to_svg(lon, lat)
                path_parts.append(f'L {x:.1f} {y:.1f}')
            path_parts.append('Z')

    bbox = (off_x, off_y, off_x + used_w, off_y + used_h)
    return ' '.join(path_parts), bbox


SVG_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0B1B3F"/>
      <stop offset="100%" stop-color="{navy}"/>
    </linearGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg)"/>

  <!-- India silhouette (dissolved from LGD_States via DuckDB-spatial).
       Filled at low opacity + thin stroke reads as a watermark; the
       outline-only version was too faint to show the Himalayan arc. -->
  <g>
    <path d="{path}" fill="#FFFFFF" fill-opacity="0.06" fill-rule="evenodd"
          stroke="{outline}" stroke-opacity="0.85" stroke-width="2" stroke-linejoin="round"/>
  </g>

  <!-- Logo mark: three map layers in saffron, white and India green (shared/brand.mjs). -->
  <g transform="translate(643,96) scale(2)">
    <path d="M20 22 L36 30 L20 38 L4 30 Z" fill="#12804A"/>
    <path d="M20 14 L36 22 L20 30 L4 22 Z" fill="#FFFFFF" stroke="#0B1B3F" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M20 4 L36 12 L20 20 L4 12 Z" fill="#F28C28"/>
  </g>

  <!-- Wordmark + tagline, right-aligned column -->
  <g font-family="ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif">
    <!-- One word, one colour: the colour lives in the mark. -->
    <text x="640" y="305" font-size="120" font-weight="800" letter-spacing="-3" fill="{fg}">bharatlas</text>

    <!-- Tagline -->
    <text x="643" y="360" font-size="32" font-weight="500" fill="{fg}" opacity="0.94">{tagline}</text>

    <!-- Sub-tagline -->
    <text x="643" y="402" font-size="22" font-weight="400" fill="{fg}" opacity="0.78">{sub}</text>

    <!-- Footer line -->
    <text x="643" y="520" font-size="18" font-weight="400" fill="{fg}" opacity="0.58">
      <tspan>{footer1}</tspan>
      <tspan x="643" y="550">{footer2}</tspan>
    </text>
  </g>
</svg>
"""


def render_svg_to_png(svg_path: Path, png_path: Path) -> None:
    """Shell out to web/scripts/render_og.mjs (Playwright-based).

    Playwright needs Node ≥ 22. System node may be older — prefer the fnm
    or nvm-managed binary if available; fall back to PATH `node`.
    """
    import os
    candidates = [
        Path.home() / '.local/share/fnm/node-versions/v22.22.1/installation/bin/node',
        Path.home() / '.nvm/versions/node/v22.22.1/bin/node',
    ]
    node_bin = next((str(p) for p in candidates if p.exists()), 'node')

    script = ROOT / 'web' / 'scripts' / 'render_og.mjs'
    env = {**os.environ, 'PATH': f'{Path(node_bin).parent}:{os.environ.get("PATH", "")}'}
    subprocess.run(
        [node_bin, str(script), str(svg_path), str(png_path), str(CANVAS_W), str(CANVAS_H)],
        check=True,
        cwd=ROOT / 'web',
        env=env,
    )


def main() -> None:
    if not SRC.exists():
        sys.exit(f'missing source: {SRC} — run scripts/fetch.sh first')

    print(f'dissolving {SRC.name} into India outline…')
    gj = dissolve_india()
    path_d, bbox = project_path(gj)
    print(f'  projected: bbox=({bbox[0]:.0f},{bbox[1]:.0f})—({bbox[2]:.0f},{bbox[3]:.0f})')
    print(f'  path: {len(path_d)} chars')

    for v in VARIANTS:
        svg = SVG_TMPL.format(
            w=CANVAS_W, h=CANVAS_H,
            navy=NAVY_BG,
            outline=SAFFRON,
            fg=FG_LIGHT,
            path=path_d,
            tagline=v['tagline'],
            sub=v['sub'],
            footer1=v['footer'][0],
            footer2=v['footer'][1],
        )
        svg_out = OUT_DIR / f'{v["name"]}.svg'
        png_out = OUT_DIR / f'{v["name"]}.png'
        svg_out.write_text(svg, encoding='utf-8')
        render_svg_to_png(svg_out, png_out)
        print(f'  {v["name"]}.png  ({png_out.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
