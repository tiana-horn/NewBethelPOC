// CHANGE-04 §4 — the required-inputs manifest. Each mode declares which intake
// inputs are required / recommended / optional so the UI can badge each upload
// slot and Gate 0 confirm can BLOCK while a required kind is missing (the same
// mechanism CHANGE-02 already used for its own input set, now formalized as data).

import type { InputKind } from '../intake/normalize';
import type { Mode } from '../shared/types';

export interface RequiredInputsManifest {
  required: InputKind[];
  recommended: InputKind[];
  optional: InputKind[];
  notes: Partial<Record<InputKind, string>>;
}

// CHANGE-05 §7 — Mode A requires just ONE spatial/feature source (any of the
// SPATIAL kinds below); everything else is recommended/optional. The OmniClass
// `bim-classification` requirement is gone (§1) — a COBie workbook is now simply
// one of the accepted feature sources, read for spaces/finishes/products (§4.1).
const SPATIAL: InputKind[] = ['finish-schedule', 'bim-ifc', 'bim-classification', 'drawings'];
const UFGS_MANIFEST: RequiredInputsManifest = {
  required: [], // satisfied by "at least one SPATIAL source" — see missingRequiredInputs
  recommended: ['finish-schedule', 'bim-ifc', 'program'],
  optional: ['bim-classification', 'standards', 'ref-spec', 'drawings'],
  notes: {
    'finish-schedule': 'Room/finish schedule (CSV or XLSX) or a COBie workbook — primary ground truth for finishes and product features.',
    'bim-ifc': 'IFC model — spaces + building elements (doors/windows/coverings) the SEC matcher selects sections from (§4).',
    'bim-classification': 'A COBie workbook (spaces, finishes, product/system features). No OmniClass code is read (§1).',
    program: 'deliveryMethod/agency may be satisfied by the setup selection + UFC criteria; a formal BOD is recommended, not required.',
    standards: 'UFC/agency criteria play this role for Army/USACE; a separate upload is only needed beyond standard UFC criteria.',
    drawings: 'Counts as a spatial source when no IFC/COBie/schedule is present.',
  },
};

// Modes B/C — restates CHANGE-02 §2 (finish-schedule required, rest optional),
// formalized so the UI renders it.
const DIRECT_MANIFEST: RequiredInputsManifest = {
  required: ['finish-schedule'],
  recommended: ['bim-ifc', 'program'],
  optional: ['drawings', 'standards', 'ref-spec'],
  notes: {
    'finish-schedule': 'Room/finish schedule (CSV or XLSX) — the primary ground truth for all modes.',
  },
};

export function requiredInputsFor(mode: Mode | null | undefined): RequiredInputsManifest {
  return mode === 'UFGS' ? UFGS_MANIFEST : DIRECT_MANIFEST;
}

// Gate 0 blocker: which required kinds have no successfully-parsed input row.
// `drawings` becomes conditionally required when no other spatial source exists.
export function missingRequiredInputs(
  mode: Mode | null | undefined,
  parsedKinds: Set<string>,
): InputKind[] {
  const manifest = requiredInputsFor(mode);
  const missing = manifest.required.filter((k) => !parsedKinds.has(k));
  // CHANGE-05 §7 — Mode A blocks Gate 0 only when NO spatial/feature source
  // exists at all; any one of the SPATIAL kinds satisfies it. (Modes B/C keep
  // their explicit `required` list until they are removed in Stage 1.)
  if (mode === 'UFGS' && !SPATIAL.some((k) => parsedKinds.has(k))) missing.push('finish-schedule');
  return missing;
}
