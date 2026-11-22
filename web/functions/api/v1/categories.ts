import { catalogEndpoint, toApiCategory } from '../../lib/catalog-api';

export const onRequestGet = catalogEndpoint(toApiCategory);
