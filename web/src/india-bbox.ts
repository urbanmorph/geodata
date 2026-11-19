/** India's extent [west, south, east, north]: the map's start view, the upload
 *  check's "outside India" test and the ?at= deep-link gate. Its own module, so
 *  the home page (find-my-ward, via locate-actions) does not load validate.ts. */
export const INDIA_BBOX: [number, number, number, number] = [68, 6, 98, 38];
