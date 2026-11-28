"""Matching the Scheduled Areas orders' named units to LGD units: name keys and the match within a pool.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_match_scheduled_areas.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import match_scheduled_areas as m  # noqa: E402


def test_key_ignores_case_spaces_and_punctuation():
    assert m.name_key('Abu Road') == m.name_key('ABUROAD') == m.name_key('Abu-Road.')


def test_key_folds_common_transliteration_variants():
    # doubled letters, ee/i, oo/u, w/v, aspirates
    assert m.name_key('Kukunoor') == m.name_key('Kukunur')
    assert m.name_key('Lasadia') == m.name_key('Lasadiya')
    assert m.name_key('Bhadrachalam') == m.name_key('Badrachalam')
    assert m.name_key('Mulakalapalle') == m.name_key('Mulakalapally') == m.name_key('Mulakalapalli')
    assert m.name_key('Narsapur') != m.name_key('Narsampet')


def test_key_drops_census_tags_in_brackets():
    assert m.name_key('Kothagudem (M)') == m.name_key('Kothagudem')
    assert m.name_key('Yellandu (M + OG)') == m.name_key('Yellandu')
    assert m.name_key('Bhadrachalam (CT)') == m.name_key('Bhadrachalam')


def test_name_variants_keep_the_name_in_brackets_as_an_alias():
    assert m.name_key('Phalasia') in m.name_variants('Jhadol (erstwhile Phalasia)')
    assert m.name_key('Jhadol') in m.name_variants('Jhadol (erstwhile Phalasia)')
    # a census tag is not an alias
    assert m.name_variants('Kothagudem (M)') == {m.name_key('Kothagudem')}


POOL = [
    {'id': 1, 'name': 'Kukunoor'},
    {'id': 2, 'name': 'Ramachandrapuram'},
    {'id': 3, 'name': 'Ramachandrapuram'},
    {'id': 4, 'name': 'Venkatapuram'},
    {'id': 5, 'name': 'Gangaram'},
]


def test_exact_match_after_normalising():
    r = m.match_name('Kukunur', POOL)
    assert (r.status, r.ids) == ('exact', [1])


def test_two_units_with_the_same_name_are_ambiguous_not_guessed():
    r = m.match_name('Ramachandrapuram', POOL)
    assert r.status == 'ambiguous'
    assert sorted(r.ids) == [2, 3]


def test_close_spelling_is_a_fuzzy_match_with_its_score():
    r = m.match_name('Venkatapurum', POOL)
    assert r.status == 'fuzzy' and r.ids == [4] and r.score >= m.FUZZY


def test_a_name_with_no_close_unit_is_unmatched():
    r = m.match_name('Bhuli', POOL)
    assert r.status == 'none' and r.ids == []


def test_a_weak_best_guess_is_review_not_a_match():
    r = m.match_name('Gangarampet', POOL)
    assert r.status in ('review', 'none')
    assert r.status != 'fuzzy'


# --- resolving a unit inside the pool its parents allow ---------------------------------------

def geo():
    return m.Geo(
        districts=[{'state': 'TELANGANA', 'name': 'Khammam', 'id': 509},
                   {'state': 'TELANGANA', 'name': 'Bhadradri Kothagudem', 'id': 690},
                   {'state': 'TELANGANA', 'name': 'Nalgonda', 'id': 514}],
        subdistricts=[{'dist': 690, 'name': 'Yellandu', 'id': 4600},
                      {'dist': 690, 'name': 'Dummugudem', 'id': 4601},
                      {'dist': 514, 'name': 'Miryalaguda', 'id': 4700}],
        blocks=[], panchayats=[],
        villages=[{'dist': 690, 'sub': 4601, 'name': 'Ramachandrapuram', 'id': 578958},
                  {'dist': 690, 'sub': 4600, 'name': 'Ramachandrapuram', 'id': 999001},
                  {'dist': 514, 'sub': 4700, 'name': 'Kothaguda', 'id': 577509},
                  {'dist': 690, 'sub': 4600, 'name': 'Sudimalla', 'id': 579400}],
        successors={'Telangana': {'Warrangal': ['Khammam', 'Bhadradri Kothagudem']}},
    )


def unit(**kw):
    base = {'state': 'Telangana', 'unit_level': 'village', 'unit_name': '', 'parent_district': 'Warrangal',
            'parent_subdistrict_or_block': '', 'whole_or_part': 'whole'}
    return {**base, **kw}


def test_a_district_resolves_to_all_its_current_successors():
    r = geo().resolve(unit(unit_level='district', unit_name='Warrangal'))
    assert (r.layer, r.status, sorted(r.ids)) == ('lgd_districts', 'exact', [509, 690])


def test_a_village_is_searched_only_in_its_parents_districts():
    # Kothaguda exists, but in Nalgonda, which the order's district does not descend to
    r = geo().resolve(unit(unit_name='Kothaguda'))
    assert r.status == 'none'


def test_a_parent_subdistrict_narrows_a_repeated_village_name():
    r = geo().resolve(unit(unit_name='Ramachandrapuram', parent_subdistrict_or_block='Dummugudem'))
    assert (r.status, r.ids, r.scope) == ('exact', [578958], 'subdistrict')


def test_an_unknown_parent_subdistrict_falls_back_to_the_districts_and_says_so():
    r = geo().resolve(unit(unit_name='Sudimalla', parent_subdistrict_or_block='Yellandu taluq (old)'))
    assert r.ids == [579400] and r.scope in ('subdistrict', 'district')
    r = geo().resolve(unit(unit_name='Ramachandrapuram', parent_subdistrict_or_block='Nowhere'))
    assert (r.status, r.scope) == ('ambiguous', 'district')


def test_a_unit_with_no_boundary_layer_is_listed_as_needing_a_list():
    r = geo().resolve(unit(unit_level='other', unit_name='Patwari circle No. 12'))
    assert (r.status, r.layer) == ('needs_list', None)


def test_a_district_the_successor_table_lacks_is_an_error_not_a_silent_miss():
    import pytest
    with pytest.raises(KeyError):
        geo().resolve(unit(unit_level='district', unit_name='Nowhere', parent_district='Nowhere'))


def test_odisha_tahsils_are_not_matched_to_police_station_areas():
    g = geo()
    g.successors['Odisha'] = {'Keonjhar': ['Kendujhar']}
    g.districts.append({'state': 'ODISHA', 'name': 'Kendujhar', 'id': 361})
    g.subdistricts.append({'dist': 361, 'name': 'Champua', 'id': 9})
    r = g.resolve({'state': 'Odisha', 'unit_level': 'tahsil', 'unit_name': 'Champua', 'parent_district': 'Keonjhar'})
    assert (r.status, r.layer) == ('needs_list', None)


def test_budruk_and_khurd_match_their_abbreviations_and_stay_apart():
    assert m.name_key('RahpalliBudruk') == m.name_key('Rahpalli Bk.') == m.name_key('Rahpalli (B)')
    assert m.name_key('Asan Khurd') == m.name_key('Asan Kh.') == m.name_key('Asan (K)')
    assert m.name_key('Asan Khurd') != m.name_key('Asan Budruk')


def test_a_final_vowel_does_not_separate_two_spellings():
    assert m.name_key('Taloda') == m.name_key('Talode')
    assert m.name_key('Subbampet') == m.name_key('Subbampeta')


def test_a_tag_letter_breaks_a_tie_between_same_named_units():
    pool = [{'id': 1, 'name': 'Venkatapuram (Z)'}, {'id': 2, 'name': 'Venkatapuram (G)'}]
    assert m.match_name('Venkatapuram (Z)', pool).ids == [1]
    assert m.match_name('Venkatapuram', pool).status == 'ambiguous'


def test_a_gram_panchayat_or_block_in_the_parent_narrows_a_village():
    g = geo()
    g.villages = [{'dist': 690, 'sub': 4600, 'block': 'YELLANDU', 'gp': 'KEWALPURA', 'name': 'Kalyanpura', 'id': 1},
                  {'dist': 690, 'sub': 4600, 'block': 'YELLANDU', 'gp': 'OTHER', 'name': 'Kalyanpura', 'id': 2}]
    r = g.resolve(unit(unit_name='Kalyanpura', parent_subdistrict_or_block='Yellandu tehsil / Kewalpura GP'))
    assert (r.status, r.ids, r.scope) == ('exact', [1], 'gram_panchayat')


def test_descriptive_words_in_a_unit_name_are_not_part_of_the_name():
    g = geo()
    r = g.resolve(unit(unit_level='subdistrict', unit_name='Yellandu taluq (all villages, with exclusions)'))
    assert (r.status, r.ids) == ('exact', [4600])
    g.blocks = [{'dist': 690, 'name': 'KHALWA', 'id': 3839}]
    r = g.resolve(unit(unit_level='block', unit_name='Khalwa Tribal Development Block'))
    assert (r.status, r.ids) == ('exact', [3839])


def test_a_gram_panchayat_is_narrowed_by_the_tehsil_or_block_in_its_parent():
    g = geo()
    g.panchayats = [{'dist': 690, 'sub': 4600, 'block': 'YELLANDU', 'name': 'ORA', 'id': 'gp1'},
                    {'dist': 690, 'sub': 4601, 'block': 'DUMMUGUDEM', 'name': 'ORA', 'id': 'gp2'}]
    r = g.resolve(unit(unit_level='gram_panchayat', unit_name='Ora', parent_subdistrict_or_block='Dummugudem tehsil'))
    assert (r.status, r.ids) == ('exact', ['gp2'])


def test_a_checked_override_names_the_lgd_unit_for_a_spelling_no_rule_can_bridge():
    g = geo()
    g.subdistricts.append({'dist': 690, 'name': 'Peth', 'id': 4150})
    g.overrides = {('Telangana', 'subdistrict', 'Peint', 'Warrangal'): {'level': 'subdistrict', 'name': 'Peth'}}
    r = g.resolve(unit(unit_level='subdistrict', unit_name='Peint'))
    assert (r.status, r.ids) == ('override', [4150])


def test_numbers_in_a_name_keep_two_units_apart():
    assert m.name_key('Gorella-1') == m.name_key('GAURELLA-1') != m.name_key('Gaurella-2')


def test_devanagari_names_compare_with_their_latin_spelling():
    assert m.name_key('रानीसागर') == m.name_key('Ranisagar')
    assert m.name_key('सेमरिया') == m.name_key('Semariya')
    assert m.name_key('कोटा') == m.name_key('Kota')


def test_a_census_code_joins_a_village_before_any_name_is_compared():
    g = geo()
    g.villages = [{'dist': 690, 'sub': 4600, 'name': 'Mahulpali', 'id': 7, 'code': '381409'}]
    r = g.resolve(unit(unit_name='mahula riha', census_code='381409'))
    assert (r.status, r.ids, r.scope) == ('code', [7], 'code')
    r = g.resolve(unit(unit_name='mahula riha', census_code='999999'))
    assert r.status != 'code'
