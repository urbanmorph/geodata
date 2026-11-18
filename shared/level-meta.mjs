// Built-in level labels, units and descriptions, in plain English: one source
// for the home and /layers cards (web/scripts/prerender.mjs) and the /view page
// meta and article (web/functions/lib/view-dataset.ts). Externally ingested
// levels carry their own entries in catalog.json's level_meta.
// `seo_description` is the shorter text for a search snippet (<= 158 chars),
// set only where `description` runs longer.

export const LEVEL_META = Object.freeze({
  country: {
    label: 'India national boundary (2024)',
    unit: 'country (MultiPolygon)',
    description: "India's national boundary as a single MultiPolygon. Derived by dissolving the 36 LGD state and UT polygons, so it's India-correct by construction (Aksai Chin via J&K/Ladakh, full Arunachal Pradesh claim). LGD snapshot 2024.",
    seo_description: "India's national boundary as a single MultiPolygon, dissolved from the 36 LGD state and UT polygons. LGD snapshot 2024.",
  },
  state: {
    label: 'States (2024)',
    unit: 'states & UTs',
    description: 'Pan-India state and Union Territory boundaries. The base layer for every drill-down. LGD snapshot 2024.',
  },
  district: {
    label: 'Districts (2024)',
    unit: 'districts',
    description: 'Every district in India. Joins to states via the LGD code. LGD snapshot 2024.',
  },
  subdistrict: {
    label: 'Sub-districts (2024)',
    unit: 'sub-districts',
    description: 'Tehsils, talukas and sub-divisions, the layer below a district. LGD snapshot 2024.',
  },
  block: {
    label: 'Blocks (2024)',
    unit: 'community-development blocks',
    description: 'Community-development blocks. The administrative unit that groups villages. LGD snapshot 2024.',
  },
  panchayat: {
    label: 'Gram Panchayats (2024)',
    unit: 'gram panchayats',
    description: 'Village-level local governance units. The constitutional tier below block, above village. 319k polygons. LGD snapshot 2024.',
  },
  village: {
    label: 'Villages (2024)',
    unit: 'villages',
    description: 'Every revenue village in India. The finest admin polygon, 584k of them. LGD snapshot 2024.',
  },

  // Electoral
  parliament_constituency: {
    label: 'Lok Sabha constituencies (2008 delimitation)',
    unit: 'parliament constituencies',
    description: 'All 543 Lok Sabha constituency polygons from the 2008 Delimitation Commission (based on Census 2001). In effect since the 2009 general election.',
  },
  assembly_constituency: {
    label: 'Vidhan Sabha constituencies (2008 delimitation)',
    unit: 'assembly constituencies',
    description: 'State legislative assembly constituency polygons across India. 2008 Delimitation Commission boundaries.',
  },
  high_court: {
    label: 'High Court jurisdictions (2024)',
    unit: 'high courts',
    description: "Territorial jurisdiction of India's 25 High Courts. Dissolved from LGD 2024 state polygons per the constitutional assignment of states to each court.",
  },
  ngt_zone: {
    label: 'NGT zonal benches (2017)',
    unit: 'NGT zones',
    description: "National Green Tribunal's 5 zonal bench jurisdictions (Delhi, Bhopal, Kolkata, Chennai, Pune). Dissolved from LGD state polygons per the 2017 gazette notification.",
    seo_description: "National Green Tribunal's 5 zonal bench jurisdictions. Per the 2017 gazette notification.",
  },
  nclt_bench: {
    label: 'NCLT benches (2024)',
    unit: 'NCLT benches',
    description: "National Company Law Tribunal's 15 bench jurisdictions. Dissolved from LGD state polygons per nclt.gov.in bench assignments.",
  },

  // Postal
  pincode: {
    label: 'Pin codes (2025)',
    unit: 'pincode polygons',
    description: 'India Post pincode boundary polygons. Generated 2025. Joinable to many user-supplied datasets via postal code.',
  },

  // Environment
  wildlife: {
    label: 'Wildlife sanctuaries + national parks (2024)',
    unit: 'protected areas',
    description: 'Protected-area polygons across India, wildlife sanctuaries and national parks. Via PM GatiShakti, snapshot 2024.',
  },
  eco_zone: {
    label: 'Eco-sensitive zones (2024)',
    unit: 'eco-sensitive zones',
    description: 'MoEFCC-notified eco-sensitive zones around protected areas. Via Bharatmaps Parivesh, snapshot 2024.',
  },
  forest: {
    label: 'Forest boundaries (SOI)',
    unit: 'forest polygons',
    description: 'Reserved, protected, and unclassed forest boundary polygons from Survey of India topographic maps.',
  },
  ramsar: {
    label: 'Ramsar wetlands (2024)',
    unit: 'Ramsar sites',
    description: "India's wetland sites of international importance under the Ramsar Convention. Via Bharatmaps Parivesh, snapshot 2024.",
  },
  wetland: {
    label: 'Wetland boundaries (2024)',
    unit: 'wetlands',
    description: 'All wetland polygons notified under MoEFCC Wetland Rules 2017. Via Bharatmaps Parivesh, snapshot 2024.',
  },
  river_basin: {
    label: 'River basins (2024)',
    unit: 'major river basins',
    description: "India's major river basin polygons from the Central Water Commission's Water Resources Information System (WRIS). Snapshot 2024.",
  },
  river_subbasin: {
    label: 'River sub-basins (2024)',
    unit: 'sub-basins',
    description: 'One tier finer than basins. For catchment-scale water-resources analysis. From CWC WRIS, snapshot 2024.',
  },
  river: {
    label: 'Rivers + streams (2024)',
    unit: 'river segments',
    description: "India's river network as line geometry. Streams, rivers, and tributaries from CWC WRIS, snapshot 2024.",
  },
  flood_event: {
    label: 'Historical flood polygons (1960s-2020)',
    unit: 'flood events',
    description: 'India Flood Inventory v3.0. 1,006 historical flood event polygons across India from the 1960s to 2020.',
  },
  seismic_zone: {
    label: 'Seismic zones (IS 1893:2016)',
    unit: 'seismic zones',
    description: 'BIS IS 1893:2016 earthquake hazard zones II-V covering all of India. The current national seismic zonation standard.',
  },
  dam: {
    label: 'Dams (2024)',
    unit: 'dams',
    description: 'Dam point locations across India. Two sources: Bharatmaps and CWC WRIS, both snapshot 2024. Compare for cross-source coverage.',
  },
  reservoir: {
    label: 'Reservoirs (2024)',
    unit: 'reservoirs',
    description: 'Reservoir polygons from CWC WRIS, snapshot 2024. Complements the river basin, sub-basin, and river network layers.',
  },
  airport: {
    label: 'Airports (2024)',
    unit: 'airports',
    description: 'Airports across India. 151 point features with name, type, district, and state. From data.gov.in, snapshot 2024.',
  },
  national_highway: {
    label: 'National highways (2024)',
    unit: 'highway segments',
    description: 'National highway centerlines from the Ministry of Road Transport and Highways via PM GatiShakti, snapshot 2024.',
  },
  health_facility: {
    label: 'Health facilities (2020)',
    unit: 'health facilities',
    description: 'Primary Health Centres, Community Health Centres, sub-centres, and district hospitals from NIC HealthGIS. 147,957 point features. Scraped March 2020.',
  },
});
