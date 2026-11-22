// Counted lines on the "Submit to bharatlas?" sheet, with verbs that agree.
import { plural } from '../util';

export const savedLine = (n: number): string =>
  `Your ${plural(n, 'approved point')} ${n === 1 ? 'is' : 'are'} already saved and shown on this map.`;

export const pendingLine = (n: number): string =>
  `${plural(n, 'pending point')} won't be included until you approve ${n === 1 ? 'it' : 'them'} in Review.`;
