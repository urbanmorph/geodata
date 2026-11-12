// Each ward map's city and state on the sister sites: mugilu (the sky over the city now) and yellide (the species
// of the state). The /view article links them for ward layers (view-dataset.ts). `mugilu` is the city's page slug
// (mugilu.live/c/<slug>), or, where mugilu has no city page, the city centre as [lat, lon]
// (mugilu.live/c/<lat>,<lon>). `state` is yellide's place slug (yellide.com/in/<state>). Checked against both
// sites on 12 Nov 2026; a test holds every ward layer in the catalog to having an entry.

export type WardPlace = { city: string; mugilu: string | readonly [number, number]; state: string; stateName: string };

export const WARD_PLACES: Record<string, WardPlace> = {
  wards_ahmedabad: { city: 'Ahmedabad', mugilu: 'ahmedabad', state: 'gujarat', stateName: 'Gujarat' },
  wards_mumbai: { city: 'Mumbai', mugilu: 'mumbai', state: 'maharashtra', stateName: 'Maharashtra' },
  wards_delhi: { city: 'Delhi', mugilu: 'delhi', state: 'delhi', stateName: 'Delhi' },
  wards_bengaluru_gba: { city: 'Bengaluru', mugilu: 'bengaluru', state: 'karnataka', stateName: 'Karnataka' },
  wards_bengaluru_bbmp_2022: { city: 'Bengaluru', mugilu: 'bengaluru', state: 'karnataka', stateName: 'Karnataka' },
  wards_hyderabad: { city: 'Hyderabad', mugilu: 'hyderabad', state: 'telangana', stateName: 'Telangana' },
  wards_chennai: { city: 'Chennai', mugilu: 'chennai', state: 'tamil-nadu', stateName: 'Tamil Nadu' },
  wards_kolkata: { city: 'Kolkata', mugilu: 'kolkata', state: 'west-bengal', stateName: 'West Bengal' },
  wards_pune: { city: 'Pune', mugilu: 'pune', state: 'maharashtra', stateName: 'Maharashtra' },
  wards_pcmc: { city: 'Pimpri-Chinchwad', mugilu: [18.629, 73.8], state: 'maharashtra', stateName: 'Maharashtra' },
  wards_thane: { city: 'Thane', mugilu: 'thane', state: 'maharashtra', stateName: 'Maharashtra' },
  wards_navi_mumbai: { city: 'Navi Mumbai', mugilu: [19.033, 73.029], state: 'maharashtra', stateName: 'Maharashtra' },
  wards_surat: { city: 'Surat', mugilu: 'surat', state: 'gujarat', stateName: 'Gujarat' },
  wards_vadodara: { city: 'Vadodara', mugilu: 'vadodara', state: 'gujarat', stateName: 'Gujarat' },
  wards_bhubaneshwar: { city: 'Bhubaneswar', mugilu: 'bhubaneswar', state: 'odisha', stateName: 'Odisha' },
  wards_indore: { city: 'Indore', mugilu: 'indore', state: 'madhya-pradesh', stateName: 'Madhya Pradesh' },
  wards_bhopal: { city: 'Bhopal', mugilu: 'bhopal', state: 'madhya-pradesh', stateName: 'Madhya Pradesh' },
  wards_jaipur: { city: 'Jaipur', mugilu: 'jaipur', state: 'rajasthan', stateName: 'Rajasthan' },
  wards_gurugram: { city: 'Gurugram', mugilu: 'gurugram', state: 'haryana', stateName: 'Haryana' },
  wards_faridabad: { city: 'Faridabad', mugilu: 'faridabad', state: 'haryana', stateName: 'Haryana' },
  wards_chandigarh: { city: 'Chandigarh', mugilu: 'chandigarh', state: 'chandigarh', stateName: 'Chandigarh' },
  wards_kochi: { city: 'Kochi', mugilu: 'kochi', state: 'kerala', stateName: 'Kerala' },
  wards_vizag: { city: 'Visakhapatnam', mugilu: 'visakhapatnam', state: 'andhra-pradesh', stateName: 'Andhra Pradesh' },
  wards_vijayawada: { city: 'Vijayawada', mugilu: [16.506, 80.648], state: 'andhra-pradesh', stateName: 'Andhra Pradesh' },
  wards_coimbatore: { city: 'Coimbatore', mugilu: 'coimbatore', state: 'tamil-nadu', stateName: 'Tamil Nadu' },
  wards_madurai: { city: 'Madurai', mugilu: 'madurai', state: 'tamil-nadu', stateName: 'Tamil Nadu' },
  wards_guwahati: { city: 'Guwahati', mugilu: 'guwahati', state: 'assam', stateName: 'Assam' },
  wards_mysuru: { city: 'Mysuru', mugilu: 'mysuru', state: 'karnataka', stateName: 'Karnataka' },
  wards_lucknow: { city: 'Lucknow', mugilu: 'lucknow', state: 'uttar-pradesh', stateName: 'Uttar Pradesh' },
  wards_kanpur: { city: 'Kanpur', mugilu: 'kanpur', state: 'uttar-pradesh', stateName: 'Uttar Pradesh' },
  wards_patna: { city: 'Patna', mugilu: 'patna', state: 'bihar', stateName: 'Bihar' },
};

/** mugilu's page for the place: its city page, or the page for its centre point. */
export const mugiluUrl = (p: WardPlace): string =>
  `https://mugilu.live/c/${typeof p.mugilu === 'string' ? p.mugilu : `${p.mugilu[0]},${p.mugilu[1]}`}`;

/** yellide's page for the place's state. */
export const yellideUrl = (p: WardPlace): string => `https://yellide.com/in/${p.state}`;
