import { PALETTE } from '../../shared/brand.mjs';

// One-line descriptions on the home page's theme cards ("Browse by theme").
// Every catalog category needs one, including themes that only appear when a
// community layer uses them (tests/themes.test.ts checks against catalog.json).
export const THEME_DESC = {
  all: 'Every layer in the atlas',
  boundaries: 'Country to village: states, districts, blocks, panchayats and towns',
  'city-wards': 'Ward and zone maps for {cities} cities',
  people: 'Constituencies, courts and police station areas',
  environment: 'Forests, coasts, geology, minerals and natural hazards',
  water: 'Rivers, lakes, watersheds, aquifers, groundwater and floods',
  agriculture: 'Agro-climatic zones, soil health and cropping',
  transport: 'Railways, highways, airports and rural roads',
  infrastructure: 'Pincodes, power plants, renewables, oil and gas',
  'health-edu': 'Hospitals, health facilities and schools',
  economy: 'MGNREGA, city budgets and state finances',
  culture: 'Heritage sites, monuments and cultural places',
  other: 'Layers that fit no other theme',
  community: 'Layers people added under open licences',
};

/** A theme's description, with {cities} filled by the number of cities with ward maps. */
export function themeDesc(id, cityCount) {
  return (THEME_DESC[id] ?? '').replace('{cities}', String(cityCount));
}

// Map symbols for the legend (Direction A, survey sheet): a closed shape in a
// 28-unit box and its fill (brand colours from PALETTE; 'ink' = the text colour).
// Every theme has its own (tests/themes.test.ts).
export const THEME_GLYPH = {
  all: { d: 'M4 4 H24 V24 H4 Z M4 14 H24 M14 4 V24', fill: PALETTE.white },
  boundaries: { d: 'M5 5 H23 V23 H5 Z', fill: PALETTE.white },
  'city-wards': { d: 'M8 4 H20 L26 14 L20 24 H8 L2 14 Z', fill: PALETTE.saffron },
  people: { d: 'M14 5 A9 9 0 1 1 13.9 5 Z', fill: PALETTE.saffronLight },
  environment: { d: 'M14 4 L24 23 H4 Z', fill: PALETTE.green },
  water: { d: 'M3 11 Q8 5 14 11 T25 11 V22 H3 Z', fill: '#7FB8E6' },
  agriculture: { d: 'M5 9 H23 V23 H5 Z M5 16 H23 M11 9 V23 M17 9 V23', fill: '#B7DCC4' },
  transport: { d: 'M3 11 H25 V17 H3 Z', fill: 'ink' }, // the text colour, so it shows in dark mode
  infrastructure: { d: 'M14 3 L25 14 L14 25 L3 14 Z', fill: '#C8D0E3' },
  'health-edu': { d: 'M11 4 H17 V11 H24 V17 H17 V24 H11 V17 H4 V11 H11 Z', fill: PALETTE.white },
  economy: { d: 'M5 23 V15 H10 V23 Z M12 23 V9 H17 V23 Z M19 23 V4 H24 V23 Z', fill: PALETTE.saffron },
  culture: { d: 'M4 24 V12 L14 4 L24 12 V24 Z', fill: PALETTE.saffronLight },
  other: { d: 'M7 7 H21 V21 H7 Z', fill: '#E6F2EA' },
  community: { d: 'M14 25 C10 19 6 15 6 11 A8 8 0 1 1 22 11 C22 15 18 19 14 25 Z', fill: PALETTE.saffron },
};
