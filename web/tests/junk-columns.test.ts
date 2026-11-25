import { describe, it, expect } from 'vitest';
import { cleanProperties } from '../functions/lib/mvt-locate';

describe('GIS artefact columns', () => {
  it('locate drops the __mlocate fields a file conversion left (biogeographic_zones), and keeps the source attributes', () => {
    const props = { __mlocate0: 156, __mlocate4: '2009-02-16', __mlocate8: '2009-02-16', __mlocate_: 174696, prov_code: '8A', biogeozone: 'Coasts', OBJECTID: 3 };
    expect(cleanProperties(props)).toEqual({ prov_code: '8A', biogeozone: 'Coasts', OBJECTID: 3 });
  });
});
