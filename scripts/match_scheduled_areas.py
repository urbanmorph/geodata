"""Match the units the Scheduled Areas orders name (districts, tehsils, blocks, panchayats, villages)
to LGD units, so the Fifth and Sixth Schedule layers can be drawn from bharatlas boundaries.

The orders spell places as they were spelt when notified (1950 to 2018), with no codes. A name is
matched only inside the pool its parent units allow (the current districts and subdistricts that
descend from the order's), and is never guessed: two units with the same name are 'ambiguous', a
weak best guess is 'review', and nothing close is 'none'. Every unmatched unit stays on the list.

Run: python3 -u scripts/match_scheduled_areas.py   (writes the match tables and a per-state report)
"""
from __future__ import annotations

import csv
import json
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

FUZZY = 0.88   # at or above: a match by spelling
REVIEW = 0.75  # at or above (below FUZZY): a candidate a person must confirm
MARGIN = 0.04  # the best fuzzy candidate must beat the next by this much

# Census and LGD tags in brackets that are not part of a name: (M), (CT), (OG), (M + OG), (N.V.), (P.L) ...
TAG = re.compile(r'^\s*(m|ct|og|m\s*\+\s*og|nv|n\.v\.?|p\.?l\.?|r|rural|u|urban|part|forest village|fv|'
                 r'm\.?\s*corp\.?|nsm|[a-z])\s*$', re.I)
BRACKET = re.compile(r'\(([^()]*)\)')
ALIAS_WORDS = re.compile(r'^\s*(erstwhile|old|now|formerly|also|alias|or)\s+', re.I)

# Spelling folds, applied in order to a lowercase, letters-only name.
FOLDS = [
    (re.compile(r'(palle|pally|palli|palem|pali)'), 'pali'),
    (re.compile(r'([bcdgjkpt])h'), r'\1'),     # aspirates: bh->b, th->t ...
    (re.compile(r'ee|ie'), 'i'),
    (re.compile(r'oo|ou'), 'u'),
    (re.compile(r'au'), 'o'),                    # Gorella / Gaurella
    (re.compile(r'w'), 'v'),
    (re.compile(r'iya'), 'ia'),
    (re.compile(r'y'), 'i'),
    (re.compile(r'(.)\1+'), r'\1'),             # doubled letters
]


# Budruk/Buzurg (the larger) and Khurd (the smaller) of a village pair, and their abbreviations.
BIG = re.compile(r'(budruk|buzurg|bujurg|\bbk\b\.?|\(\s*b\s*\))', re.I)
SMALL = re.compile(r'(khurd|\bkh\b\.?|\(\s*k\s*\))', re.I)
LETTER_TAG = re.compile(r'\(\s*([a-z])\s*\)', re.I)


# Devanagari to Latin, enough to compare a Hindi village name with its Census spelling.
DEVA_CONS = dict(zip('कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह',
                     'k kh g gh n ch chh j jh n t th d dh n t th d dh n p ph b bh m y r l v sh sh s h'.split()))
DEVA_VOWELS = dict(zip('अआइईउऊऋएऐओऔ', 'a a i i u u ri e ai o au'.split()))
DEVA_SIGNS = dict(zip('ािीुूृेैोौ', 'a i i u u ri e ai o au'.split()))


def devanagari_to_latin(text: str) -> str:
    out, i, inherent = [], 0, False
    while i < len(text):
        ch = text[i]
        inherent = False
        if ch in DEVA_CONS:
            out.append(DEVA_CONS[ch])
            nxt = text[i + 1] if i + 1 < len(text) else ''
            if nxt == '\u093c':                    # nukta: same letter for matching
                i += 1
                nxt = text[i + 1] if i + 1 < len(text) else ''
            if nxt in DEVA_SIGNS:
                out.append(DEVA_SIGNS[nxt])
                i += 1
            elif nxt != '\u094d':                  # no virama: the inherent vowel
                out.append('a')
                inherent = True
            else:
                i += 1
        elif ch in DEVA_VOWELS:
            out.append(DEVA_VOWELS[ch])
        elif ch in '\u0902\u0901':                # anusvara, chandrabindu
            out.append('n')
        elif not ('\u0900' <= ch <= '\u097f'):
            out.append(ch)
        i += 1
    if inherent:                                    # Hindi drops a word-final inherent vowel
        out.pop()
    return ''.join(out)


def name_key(name: str) -> str:
    """The comparable form of a place name: brackets dropped, letters only, common spellings folded."""
    if name and re.search('[\u0900-\u097f]', name):
        name = devanagari_to_latin(name)
    s = SMALL.sub(' khurdx ', BIG.sub(' bigx ', name or ''))
    s = BRACKET.sub(' ', s).lower()
    s = re.sub(r'[^a-z0-9]', '', s)
    for pat, rep in FOLDS:
        s = pat.sub(rep, s)
    return re.sub(r'(?<=...)[aeiou]$', '', s)   # Taloda / Talode, Subbampet / Subbampeta


def letter_tags(name: str) -> frozenset[str]:
    """Single-letter Census tags such as (Z), (G), (H) that tell same-named villages apart."""
    return frozenset(t.lower() for t in LETTER_TAG.findall(name or '') if t.lower() not in 'bk')


@lru_cache(maxsize=None)
def name_variants(name: str) -> frozenset[str]:
    """The name's key, plus the key of any real name in brackets ('Jhadol (erstwhile Phalasia)')."""
    keys = {name_key(name)}
    for inner in BRACKET.findall(name or ''):
        if TAG.match(inner):
            continue
        alias = ALIAS_WORDS.sub('', inner)
        if name_key(alias):
            keys.add(name_key(alias))
    return frozenset(k for k in keys if k)


@dataclass
class Match:
    status: str                 # exact | fuzzy | review | ambiguous | none
    ids: list = field(default_factory=list)
    score: float = 0.0
    candidates: list = field(default_factory=list)   # (id, name, score), best first


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def match_name(name: str, pool: list[dict]) -> Match:
    """Match one name against a pool of {'id', 'name'} units (already limited to the allowed parents)."""
    want = name_variants(name)
    if not want:
        return Match('none')
    exact = [u['id'] for u in pool if want & name_variants(u['name'])]
    if len(exact) == 1:
        return Match('exact', exact, 1.0)
    if len(exact) > 1:
        tags = letter_tags(name)
        same = [u['id'] for u in pool if u['id'] in exact and tags and letter_tags(u['name']) == tags]
        if len(same) == 1:
            return Match('exact', same, 1.0)
        return Match('ambiguous', exact, 1.0)
    scored = sorted(((max(_ratio(w, k) for w in want for k in name_variants(u['name'])), u['id'], u['name'])
                     for u in pool if name_variants(u['name'])), key=lambda t: (-t[0], str(t[1])))
    cands = [(i, n, round(s, 3)) for s, i, n in scored[:3]]
    if not scored or scored[0][0] < REVIEW:
        return Match('none', [], scored[0][0] if scored else 0.0, cands)
    best = scored[0][0]
    tied = [i for s, i, _ in scored if best - s < MARGIN]
    if best >= FUZZY and len(tied) == 1:
        return Match('fuzzy', tied, best, cands)
    if best >= FUZZY:
        return Match('ambiguous', tied, best, cands)
    return Match('review', [], best, cands)


# --- resolving a unit inside the pool its parent units allow -----------------------------------

LEVEL_LAYER = {
    'district': 'lgd_districts',
    'subdistrict': 'lgd_subdistricts', 'tehsil': 'lgd_subdistricts', 'tahsil': 'lgd_subdistricts',
    'taluk': 'lgd_subdistricts', 'mandal': 'lgd_subdistricts',
    'block': 'lgd_blocks',
    'gram_panchayat': 'lgd_panchayats',
    'village': 'lgd_villages',
}
# States whose lgd_subdistricts are not tehsils (Census 2011 used police stations), so a tehsil there
# can only be drawn from a village list, never matched to a subdistrict of the same name.
SUBDISTRICT_NOT_TEHSIL = {'Odisha'}
# Words an order adds to a unit's name ('Khalwa Tribal Development Block', 'Utnur taluq (all villages)').
UNIT_WORDS = re.compile(r'\b(tribal development block|development block|tribal development|taluq|taluka|taluk|'
                        r'tahsil|tehsil|mandal|block|mahal|sub-?tehsil)\b', re.I)
PARENT_WORDS = re.compile(r'\b(taluq|taluk|taluka|tahsil|tehsil|mandal|sub-?division|block|old|nsm)\b', re.I)


@dataclass
class Resolved:
    layer: str | None
    status: str                 # exact | fuzzy | review | ambiguous | none | needs_list
    ids: list = field(default_factory=list)
    score: float = 0.0
    scope: str = ''             # district | subdistrict: how narrow the pool was
    candidates: list = field(default_factory=list)


class Geo:
    """LGD units as plain rows: districts {state,name,id}; subdistricts/blocks {dist,name,id};
    panchayats {dist,block,name,id}; villages {dist,sub,name,id}; successors {state: {old: [current names]}}."""

    def __init__(self, districts, subdistricts, blocks, panchayats, villages, successors, overrides=None):
        self.districts, self.subdistricts, self.blocks = districts, subdistricts, blocks
        self.panchayats, self.villages, self.successors = panchayats, villages, successors
        # (state, level, name as the order spells it, order's district) -> the LGD name, each checked by hand
        self.overrides = overrides or {}

    def district_ids(self, state: str, old: str) -> list[int]:
        """The current districts that hold the area of the district an order names (KeyError if unmapped)."""
        names = self.successors[state][old]
        st = state.upper()
        ids = []
        for n in names:
            hit = [d['id'] for d in self.districts if d['state'].upper() == st and name_key(d['name']) == name_key(n)]
            if not hit:
                raise KeyError(f'{state}: successor district {n!r} is not in lgd_districts')
            ids += hit
        return ids

    def resolve(self, u: dict) -> Resolved:
        level, name, state = u['unit_level'], u['unit_name'], u['state']
        fixed = self.overrides.get((state, level, name, u['parent_district']))
        if fixed:
            return self._override(state, u['parent_district'], fixed)
        layer = LEVEL_LAYER.get(level)
        if layer == 'lgd_subdistricts' and state in SUBDISTRICT_NOT_TEHSIL:
            layer = None
        if layer is None:
            return Resolved(None, 'needs_list')
        if level == 'district':
            old = name if name in self.successors.get(state, {}) else u['parent_district']
            return Resolved(layer, 'exact', self.district_ids(state, old), 1.0, 'district')
        dists = set(self.district_ids(state, u['parent_district']))
        rows = {'lgd_subdistricts': self.subdistricts, 'lgd_blocks': self.blocks,
                'lgd_panchayats': self.panchayats, 'lgd_villages': self.villages}[layer]
        pool, scope = [r for r in rows if r['dist'] in dists], 'district'
        code = str(u.get('census_code') or '').strip()
        if layer == 'lgd_villages' and code:
            ids = [r['id'] for r in pool if str(r.get('code') or '') == code]
            if ids:
                return Resolved(layer, 'code', ids, 1.0, 'code')
        if level != 'village':
            name = UNIT_WORDS.sub(' ', name)
        tiers = [(scope, pool)]
        if layer in ('lgd_villages', 'lgd_panchayats'):
            tiers += self._narrow(pool, dists, u.get('parent_subdistrict_or_block') or '')
        results = [(sc, match_name(name, p)) for sc, p in reversed(tiers)]   # narrowest first
        sc, hit = next(((sc, h) for sc, h in results if h.status in ('exact', 'fuzzy')), None) or \
            next(((sc, h) for sc, h in results if h.status != 'none'), results[-1])
        return Resolved(layer, hit.status, hit.ids, hit.score, sc, hit.candidates)

    def _override(self, state: str, district: str, fixed: dict) -> Resolved:
        """A hand-checked mapping: the LGD level and name the order's unit corresponds to."""
        layer = LEVEL_LAYER[fixed['level']]
        if layer == 'lgd_districts':
            return Resolved(layer, 'override', self.district_ids(state, fixed['name']), 1.0, 'district')
        dists = set(self.district_ids(state, district))
        rows = {'lgd_subdistricts': self.subdistricts, 'lgd_blocks': self.blocks,
                'lgd_panchayats': self.panchayats, 'lgd_villages': self.villages}[layer]
        ids = [r['id'] for r in rows if r['dist'] in dists and name_key(r['name']) == name_key(fixed['name'])]
        return Resolved(layer, 'override' if ids else 'none', ids, 1.0 if ids else 0.0, 'district')

    def _narrow(self, pool: list[dict], dists: set, parent: str) -> list[tuple[str, list[dict]]]:
        """Narrower village pools from the parent text ('Bari Sadri tehsil / Kewalpura GP'): each part that
        names a subdistrict, block or gram panchayat found in the pool narrows it further."""
        tiers = []
        for part in re.split(r'[/;]', parent):
            part = part.strip()
            if re.search(r'\b(gp|g\.p\.?|gram panchayat|panchayat)\b', part, re.I):
                kind, field_ = 'gram_panchayat', 'gp'
            elif re.search(r'\bblock\b', part, re.I):
                kind, field_ = 'block', 'block'
            else:
                kind, field_ = 'subdistrict', 'sub'
            label = re.sub(r'\b(gp|g\.p\.?|gram panchayat|panchayat)\b', ' ', PARENT_WORDS.sub(' ', part), flags=re.I)
            label = label.strip(' ()-,.')
            if not label:
                continue
            if kind == 'subdistrict':
                pm = match_name(label, [x for x in self.subdistricts if x['dist'] in dists])
                keep = set(pm.ids) if pm.status in ('exact', 'fuzzy') else None
                narrowed = [r for r in pool if keep and r['sub'] in keep]
            else:
                names = [{'id': v, 'name': v} for v in sorted({r.get(field_) or '' for r in pool} - {''})]
                pm = match_name(label, names)
                keep = set(pm.ids) if pm.status in ('exact', 'fuzzy') else None
                narrowed = [r for r in pool if keep and r.get(field_) in keep]
            if narrowed:
                pool = narrowed
                tiers.append((kind, pool))
        return tiers


# --- the run: every order's list against the cached LGD attribute tables --------------------------

ROOT = Path(__file__).resolve().parent.parent
LISTS = ROOT / 'supporting-docs' / 'scheduled-areas'      # the collected order lists (gitignored)
CACHE = ROOT / 'data' / 'raw' / 'scheduled_areas'         # LGD attribute tables, no geometry
OUT = ROOT / 'data' / 'scheduled_areas'
SKIP_FILES = ('candidates', 'superseded', 'co26_now_in_maharashtra', 'telangana_goms89', 'ap_', 'r2_', 'round2_',
              'kota_ri', 'odisha_villages')
# Round 1 village rows that round 2's gazette copies replace (draft Udalguri list, 1982/1997 Mizoram lists).
SUPERSEDED = {('sixth_schedule/assam.csv', 'village'), ('sixth_schedule/mizoram.csv', 'village')}
# Village lists in the shared round-2 columns: file, how to read the census code, which rows to take.
VILLAGE_LISTS = [
    ('ap_telangana/ap_villages.csv', None, None),
    ('round2_odisha/odisha_villages_CO109_tahsils.csv', 'lgd_census2011_code', None),
    ('sixth_schedule/r2_assam_btr_villages.csv', None, lambda r: r['source_id'] == 'BTR-DELIM-2025'),
    ('sixth_schedule/r2_mizoram_adc_villages.csv', None, None),
    ('round2_gj_mp_cg/chhattisgarh_kota_ri.csv', None, lambda r: 'CONTEXT ONLY' not in r['notes']),
    ('round2_gj_mp_cg/gujarat_villages_candidates.csv', 'census_or_lgd_code',
     lambda r: r['notes'].startswith(('scheduled', 'likely scheduled'))),
]


def load_geo() -> Geo:
    import duckdb

    def rows(sql):
        con = duckdb.connect()
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    c = CACHE
    return Geo(
        districts=rows(f"SELECT stname AS state, dtname AS name, dist_lgd AS id FROM '{c}/lgd_districts.parquet'"),
        subdistricts=rows(f"SELECT dist_lgd AS dist, sdtname AS name, CASE WHEN subdt_lgd > 0 THEN subdt_lgd "
                          f"ELSE -OBJECTID END AS id FROM '{c}/lgd_subdistricts.parquet'"),
        blocks=rows(f"SELECT dist_lgd AS dist, block_name AS name, block_lgd AS id FROM '{c}/lgd_blocks.parquet'"),
        panchayats=rows(f"SELECT DISTINCT dt_lgd AS dist, sdt_lgd AS sub, blkname AS block, gp_name AS name, gp_code AS id "
                        f"FROM '{c}/lgd_panchayats.parquet' WHERE gp_name <> ''"),
        villages=rows(f"SELECT dist_lgd AS dist, subdt_lgd AS sub, block_name AS block, gp_name AS gp, "
                      f"vilcode11 AS code, vilname11 AS name, "
                      f"CASE WHEN vil_lgd > 0 THEN vil_lgd "
                      f"ELSE -OBJECTID END AS id FROM '{c}/lgd_villages.parquet' WHERE vilname11 <> ''"),
        successors=json.loads((Path(__file__).with_name('scheduled_areas_successors.json')).read_text()),
        overrides=load_overrides(),
    )


def load_overrides() -> dict:
    data = json.loads(Path(__file__).with_name('scheduled_areas_overrides.json').read_text())
    return {(o['state'], o['level'], o['name'], o['district']): {'level': o['lgd_level'], 'name': o['lgd_name']}
            for o in data['overrides']}


def load_units() -> list[dict]:
    units = []
    for f in sorted(LISTS.glob('*/*.csv')):
        if any(s in f.name for s in SKIP_FILES):
            continue
        with f.open() as fh:
            reader = csv.DictReader(fh)
            if 'unit_level' not in (reader.fieldnames or []):      # not an order list (a mapping or working file)
                continue
            for i, r in enumerate(reader):
                rel = f'{f.parent.name}/{f.name}'
                if (rel, r.get('unit_level')) in SUPERSEDED:
                    continue
                units.append({**r, 'source_file': rel, 'source_row': i + 1})
    go89 = LISTS / 'ap_telangana' / 'telangana_goms89.csv'
    if go89.exists():
        with go89.open() as fh:
            for i, r in enumerate(csv.DictReader(fh)):
                units.append({'state': 'Telangana', 'unit_level': 'village', 'unit_name': r['village'],
                              'parent_district': r['district'],
                              'parent_subdistrict_or_block': re.sub(r'\(\s*NSM\s*\)', '', r['mandal']).strip(),
                              'whole_or_part': 'whole', 'order_ref': f"TG-GOMS89-2015 Annexure {r['annexure']}",
                              'source_file': 'ap_telangana/telangana_goms89.csv', 'source_row': i + 1})
    for rel, code_col, take in VILLAGE_LISTS:
        f = LISTS / rel
        if not f.exists():
            continue
        with f.open() as fh:
            for i, r in enumerate(csv.DictReader(fh)):
                if take and not take(r):
                    continue
                units.append({'state': r['state'], 'unit_level': 'village', 'unit_name': r['village'],
                              'parent_district': r['district'] + (' (added villages)' if 'BTR' in r['source_id'] else ''),
                              'parent_subdistrict_or_block': re.sub(r'\(\s*NSM\s*\)', '', r['subdistrict_or_block']).strip(),
                              'whole_or_part': 'whole', 'census_code': r.get(code_col, '') if code_col else '',
                              'order_ref': f"{r['source_id']} {r['unit']}".strip(),
                              'source_file': rel, 'source_row': i + 1})
    return units


def main() -> None:
    t0 = time.time()
    geo, units = load_geo(), load_units()
    print(f'{len(units):,} units; LGD: {len(geo.villages):,} villages ({time.time() - t0:.0f}s)', flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    out, tally = [], Counter()
    for n, u in enumerate(units, 1):
        try:
            r = geo.resolve(u)
        except KeyError as e:
            r = Resolved(None, 'unmapped_parent', candidates=[str(e)])
        tally[(u['state'], u['unit_level'], r.status)] += 1
        keep = ('state', 'unit_level', 'unit_name', 'parent_district', 'parent_subdistrict_or_block',
                'whole_or_part', 'order_ref', 'source_file', 'source_row')
        out.append({**{k: u.get(k, '') for k in keep},
                    'census_code': u.get('census_code', ''), 'match': r.status, 'lgd_layer': r.layer or '',
                    'lgd_ids': ';'.join(map(str, r.ids)),
                    'score': round(r.score, 3), 'scope': r.scope,
                    'candidates': ' | '.join(f'{c[1]} [{c[0]}] {c[2]}' if isinstance(c, tuple) else str(c)
                                             for c in r.candidates)})
        if n % 1000 == 0:
            print(f'  {n:,}/{len(units):,} ({time.time() - t0:.0f}s)', flush=True)
    tmp = OUT / 'matches.csv.tmp'
    with tmp.open('w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    tmp.replace(OUT / 'matches.csv')
    (OUT / 'report.md').write_text(report(tally))
    print(report(tally), flush=True)


def report(tally: Counter) -> str:
    order = ['code', 'exact', 'override', 'fuzzy', 'review', 'ambiguous', 'none', 'needs_list', 'unmapped_parent']
    states = sorted({k[0] for k in tally})
    lines = ['| state | units | ' + ' | '.join(order) + ' |', '|' + '---|' * (len(order) + 2)]
    for s in states:
        row = Counter()
        for (st, _lvl, status), n in tally.items():
            if st == s:
                row[status] += n
        lines.append(f'| {s} | {sum(row.values()):,} | ' + ' | '.join(f'{row[o]:,}' for o in order) + ' |')
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    main()
