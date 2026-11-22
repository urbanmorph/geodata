import { catalogEndpoint, toApiLevel } from '../../lib/catalog-api';

export const onRequestGet = catalogEndpoint(toApiLevel);
