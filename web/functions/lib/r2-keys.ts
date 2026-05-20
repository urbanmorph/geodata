// Derive (layer_id, state_code, format) from an R2 object key.
// Used by /api/dl/[[path]] to bump the right download counter row.
//
// Key shapes we recognise:
//   admin/<level-plural>/<stem>.<ext>          curated pan-India (LGD/SOI/Bhuvan/PMGSY)
//   extracts/<level-plural>/<NN>/<file>.<ext>  pre-baked per-state extracts (LGD-derived)
//   community/<id>/<file>.<ext>                user submission (v3.1)
//   geoboundaries/IND_ADM<N>.geojson           cross-check layers
//   boundaries/<level-plural>/<stem>_<ab>.<ext>  legacy CG/JH/OD slices

export type Classified = {
  layer_id: string;
  state_code: string;    // '' for pan-India / non-state slicing
  format: string;        // ext without the dot
};

const PLURAL_TO_LEVEL: Record<string, string> = {
  states: 'states',
  districts: 'districts',
  subdistricts: 'subdistricts',
  blocks: 'blocks',
  villages: 'villages',
};

function stemToLayerId(stem: string): string {
  // 'LGD_States' -> 'lgd_states'; 'PMGSY_Blocks' -> 'pmgsy_blocks'.
  return stem.toLowerCase();
}

export function classifyKey(key: string): Classified | null {
  if (!key || typeof key !== 'string') return null;

  // extracts/<plural>/<NN>/<file>.<ext>
  let m = key.match(/^extracts\/([a-z]+)\/(\d+)\/[^/]+\.([a-z0-9]+)$/);
  if (m) {
    const [, plural, code, ext] = m;
    if (!PLURAL_TO_LEVEL[plural]) return null;
    return { layer_id: `lgd_${plural}`, state_code: code, format: ext };
  }

  // community/<id>/<file>.<ext>
  m = key.match(/^community\/([A-Za-z0-9_-]+)\/[^/]+\.([a-z0-9]+)$/);
  if (m) {
    const [, id, ext] = m;
    return { layer_id: `c_${id}`, state_code: '', format: ext };
  }

  // admin/<plural>/<stem>.<ext>
  m = key.match(/^admin\/([a-z]+)\/([A-Za-z0-9_]+)\.([a-z0-9]+)$/);
  if (m) {
    const [, , stem, ext] = m;
    return { layer_id: stemToLayerId(stem), state_code: '', format: ext };
  }

  // geoboundaries/IND_ADM<N>.geojson
  m = key.match(/^geoboundaries\/IND_ADM(\d)\.([a-z0-9]+)$/);
  if (m) {
    const [, n, ext] = m;
    return { layer_id: `gb_adm${n}`, state_code: '', format: ext };
  }

  // boundaries/<plural>/<stem>_<state-abbr>.<ext>  (legacy CG/JH/OD)
  m = key.match(/^boundaries\/([a-z]+)\/([a-z_]+)_([a-z]{2,3})\.([a-z0-9]+)$/);
  if (m) {
    const [, plural, stem, abbr, ext] = m;
    return { layer_id: stem, state_code: abbr, format: ext };
  }

  return null;
}
