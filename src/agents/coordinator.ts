// Coordinator. Cross-checks spec content vs drawings / finish schedule and emits
// coordination flags. Deterministic comparison here; USE_AI=true could add
// semantic cross-checking, but conflicts are surfaced as structured flags either way.

import type { Env } from '../env';
import { eachParagraph } from '../shared/section-ir';
import type { CoordinationFlag, ModeContext } from '../shared/types';
import type { CoordinateInput, CoordinateOutput } from './contracts';

export async function run(
  _env: Env,
  ctx: ModeContext,
  input: CoordinateInput,
): Promise<CoordinateOutput> {
  const flags: CoordinationFlag[] = [];
  let n = 0;

  // Division 01 vs the agency General Conditions. Driven by data (a locked
  // front-end doc in the IR), not a mode branch. Division 01 must be edited to
  // eliminate conflicts with the unalterable General Conditions (which may not
  // be altered — G2).
  const lockedDoc = [...eachParagraph(input.ir)].find(({ paragraph }) => paragraph.lockedDocId);
  if (lockedDoc) {
    flags.push({
      id: `cf-${++n}`,
      type: 'division01-vs-general-conditions',
      location: `Division 01 / ${ctx.agency ?? 'agency'} General Conditions`,
      detail:
        `Draft submittal-procedure language may conflict with the unalterable "${lockedDoc.paragraph.text.slice(0, 60)}…". ` +
        'Division 01 must be edited to eliminate the conflict; the General Conditions may not be altered (G2).',
      severity: 'high',
      resolved: false,
    });
  }

  const shown = new Map(input.drawings.map((d) => [d.room, d.shownFinish.toLowerCase()]));

  // Spec-vs-drawing conflicts: schedule says one finish, drawing shows another.
  for (const row of input.schedule) {
    const drawn = shown.get(row.room);
    if (drawn && drawn !== row.finish.toLowerCase()) {
      flags.push({
        id: `cf-${++n}`,
        type: 'spec-vs-drawing-conflict',
        location: `Room ${row.room}`,
        detail: `Finish schedule lists "${row.finish}"; drawings show "${drawn}".`,
        severity: 'high',
        resolved: false,
      });
    }
  }

  // Scope note: ferrous-metal painting present — verify against schedule.
  if (input.schedule.some((r) => r.substrate.toLowerCase().includes('ferrous metal'))) {
    flags.push({
      id: `cf-${++n}`,
      type: 'scope-verification',
      location: 'Ferrous metal railings',
      detail:
        'Ferrous-metal painting is specified. Verify extent and locations against the finish schedule and drawings.',
      severity: 'medium',
      resolved: false,
    });
  }

  return { flags };
}
