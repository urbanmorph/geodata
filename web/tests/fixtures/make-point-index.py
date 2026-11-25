"""Fixtures for tests/point-index.test.ts: three small polygon layers near Bengaluru, each
in its own tiles (as the catalog's layers are) and merged as scripts/bake_point_index.py
merges them (its own tippecanoe command and sidecar): `pa` and `pb` with their fields in
the tiles (the place archive), `zz` ids only with a sidecar (the zones archive).

    python3 web/tests/fixtures/make-point-index.py
"""
import json
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).parent / 'point-index'
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
import bake_point_index as bpi  # noqa: E402


def box(w, s, e, n):
    return [[w, s], [e, s], [e, n], [w, n], [w, s]]


LAYERS = {
    # row 0 and 1: two squares side by side (Shape_Area is a GIS artefact locate leaves out)
    'pa': [({'name': 'west', 'code': 1, 'Shape_Area': 5.5}, {'type': 'Polygon', 'coordinates': [box(77.50, 12.90, 77.60, 13.00)]}),
           ({'name': 'east', 'code': 2}, {'type': 'Polygon', 'coordinates': [box(77.60, 12.90, 77.70, 13.00)]})],
    # one polygon with a hole
    'pb': [({'ward': 'W1', 'no': 7}, {'type': 'Polygon', 'coordinates': [box(77.45, 12.85, 77.75, 13.05),
                                                                         box(77.62, 12.92, 77.68, 12.98)[::-1]]})],
    # row 0 a multipolygon of two strips, row 1 the strip between them
    'zz': [({'zone': 'III', 'area': 1.5}, {'type': 'MultiPolygon', 'coordinates': [[box(77.50, 12.90, 77.55, 13.00)],
                                                                                   [box(77.65, 12.90, 77.70, 13.00)]]}),
           ({'zone': 'IV', 'area': 2.25, 'note': None}, {'type': 'Polygon', 'coordinates': [box(77.55, 12.90, 77.65, 13.00)]})],
}


def seq(lid: str, with_f: bool) -> Path:
    p = OUT / f'{lid}.geojsonl'
    p.write_text(''.join(json.dumps({'type': 'Feature', 'properties': {**props, **({'f': i + 1} if with_f else {})},
                                     'geometry': geom}) + '\n' for i, (props, geom) in enumerate(LAYERS[lid])))
    return p


def tippecanoe(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


OUT.mkdir(exist_ok=True)
for lid in LAYERS:  # each layer's own tiles, as a catalog layer has them
    tippecanoe(['tippecanoe', '-o', str(OUT / f'{lid}.pmtiles'), '-Z0', '-z14', '-pk', '-pf', '--quiet', '--force',
                '-L', f'{lid}:{seq(lid, False)}'])
tippecanoe(bpi.tippecanoe_cmd(OUT / 'place.pmtiles', [('pa', seq('pa', True)), ('pb', seq('pb', True))], ids_only=False))
tippecanoe(bpi.tippecanoe_cmd(OUT / 'zones.pmtiles', [('zz', seq('zz', True))], ids_only=True))
with seq('zz', True).open() as lines:
    (OUT / 'zz.props.json').write_text(json.dumps(bpi.sidecar_props(lines, {'shape_area'}), separators=(',', ':')))
for p in OUT.glob('*.geojsonl'):
    p.unlink()
