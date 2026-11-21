// The point lookups' public copy, shown only when the build sets POINT_PROFILES=on
// (see web/functions/lib/point-profiles.ts for the runtime side of the same flag).

const BLOCK = /<!-- point-profiles -->[\s\S]*?<!-- \/point-profiles -->\n?/g;
const MARKS = /<!-- \/?point-profiles -->\n?/g;

/** A template with its <!-- point-profiles --> ... <!-- /point-profiles --> blocks kept (markers dropped) or removed. */
export function gatePointProfiles(html, on) {
  return on ? html.replace(MARKS, '') : html.replace(BLOCK, '');
}

/** Added to the /about "Data sources" links: the rasters the lookups read (not layers, so not in catalog.json). */
export const POINT_PROFILE_ATTRIBUTION = {
  ISRIC: { name: 'ISRIC SoilGrids 2.0 (Poggio et al. 2021)', url: 'https://soilgrids.org' },
  WorldPop: { name: 'WorldPop 2020 (University of Southampton)', url: 'https://doi.org/10.5258/SOTON/WP00684' },
  CopernicusDEM: { name: 'Copernicus DEM GLO-90 (ESA, DLR, Airbus)', url: 'https://doi.org/10.5270/ESA-c5d3d65' },
};

export const POINT_PROFILE_FAQ = [
  {
    q: 'How do I find what is below a point (soil, rock, groundwater, seismic zone)?',
    a: 'GET https://bharatlas.com/api/v1/ground?lat=28.525&lng=77.085 returns the subsurface profile of a point in one call: seismic zone, nearby active faults and recorded earthquakes, rock type, aquifer and permeability, groundwater wells and quality, soil properties at three depths from ISRIC SoilGrids 2.0 (CC BY 4.0) and the nearest Soil Health Card sample, ground subsidence in megacities, and tunnels and buried utilities nearby. Each part names its source, licence, scale and year, with a one-line summary.',
  },
  {
    q: 'How do I find what is on the ground at a point (land, water, hazards, access)?',
    a: 'GET https://bharatlas.com/api/v1/surface?lat=28.525&lng=77.085 returns, in one call: the admin units, ward and pincode; elevation and slope (Copernicus DEM) and population density (WorldPop 2020); climate zones; the river basin, nearest river, water body, dam and wetland, and flood history; hazards; forests and protected areas; the nearest highway, station, airport and bus stop; the nearest hospital and school; and the nearest power line and plant. Each part names its source, licence, scale and year. For the air above the point it points to the mugilu MCP (conditions_at).',
  },
];

export const POINT_PROFILE_CREDITS = `        <p><strong>Data that is not a layer.</strong> The point lookups <a href="/docs#ground">/api/v1/ground</a> and <a href="/docs#surface">/api/v1/surface</a> read rasters we host over India: soil from <a href="https://soilgrids.org">ISRIC SoilGrids 2.0</a> (Poggio et al. 2021, CC BY 4.0); population from <a href="https://doi.org/10.5258/SOTON/WP00684">WorldPop 2020</a> (University of Southampton, CC BY 4.0); elevation and slope produced using Copernicus WorldDEM-90 &copy; DLR e.V. 2010-2014 and &copy; Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-90. Credit each source when you use its values.</p>
`;
