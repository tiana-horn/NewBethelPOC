// Bundled demo fixtures (§10). Mirror fixtures/*.csv for the zero-upload demo
// path; the /inputs endpoint also accepts uploaded CSV to override these.

import type { DrawingRow, FinishScheduleRow, ProjectParams } from './shared/types';

// §10.1 shared design intent.
export const DEFAULT_INTENT =
  'Interior painting of gypsum board walls and ceilings and ferrous-metal railings ' +
  'in an administrative office building. Low-VOC required. Eggshell on walls; ' +
  'semi-gloss on metal.';

export const DEFAULT_PARAMS: ProjectParams = {
  name: 'Administrative Office Building — Painting',
  designIntent: DEFAULT_INTENT,
  vocLimitGL: 50, // project sustainability criterion (resolves the VOC [_____])
  substratesInScope: ['gypsum board', 'ferrous metal'],
  agency: 'ARMY',
  delivery: 'DBB',
  defaultSpecifyingMethod: 'performance',
};

export const DEFAULT_SCHEDULE: FinishScheduleRow[] = [
  { room: '101-110', substrate: 'gypsum board', finish: 'paint', sheen: 'eggshell' },
  { room: '101-110', substrate: 'ferrous metal (railings)', finish: 'paint', sheen: 'semi-gloss' },
  { room: '112', substrate: 'gypsum board', finish: 'paint', sheen: 'eggshell' },
];

// Drawings show wall covering in Room 112 -> planted conflict (§10.2/§10.5).
export const DEFAULT_DRAWINGS: DrawingRow[] = [
  { room: '101-110', shownFinish: 'paint' },
  { room: '112', shownFinish: 'wall covering' },
];
