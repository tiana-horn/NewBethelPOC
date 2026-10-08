// Bridge the normalized intake model to the existing pipeline (CHANGE-02 §5).
// The pipeline is UNCHANGED: it still consumes { params, schedule, drawings }.
// This maps ExtractedProjectData + step-3 selections onto those inputs, so
// finishes drive resolution, spaces+finishes+drawings drive coordination, and
// the program drives drafting — without touching any agent.

import { DEFAULT_INTENT, DEFAULT_PARAMS } from '../fixtures';
import type { ModeSelections } from '../mode/mode-context';
import type {
  DrawingRow,
  ExtractedProjectData,
  FinishScheduleRow,
  ProjectParams,
} from '../shared/types';
import { vocLimitFromProgram } from './program';

export interface PipelineInputs {
  params: ProjectParams;
  schedule: FinishScheduleRow[];
  drawings: DrawingRow[];
}

export function toPipelineInputs(
  epd: ExtractedProjectData,
  selections: ModeSelections & { name?: string },
): PipelineInputs {
  const schedule: FinishScheduleRow[] = epd.finishes.map((f) => ({
    room: f.spaceRef,
    substrate: f.substrate,
    finish: f.finish,
    sheen: f.sheen ?? '',
  }));

  const substrates = [...new Set(schedule.map((r) => r.substrate).filter(Boolean))];
  const voc = vocLimitFromProgram(epd.program);

  const params: ProjectParams = {
    name: selections.name || undefined,
    designIntent: epd.program.designIntent?.trim() || DEFAULT_INTENT,
    vocLimitGL: voc ?? DEFAULT_PARAMS.vocLimitGL,
    substratesInScope: substrates.length ? substrates : DEFAULT_PARAMS.substratesInScope,
    agency: selections.agency,
    delivery: selections.delivery ?? epd.program.deliveryMethod,
  };

  return { params, schedule, drawings: epd.drawings };
}
