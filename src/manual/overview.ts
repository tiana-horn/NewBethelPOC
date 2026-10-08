// CHANGE-08 §3/§4 — the Project Manual page's server-side derive. Computing the
// five summary tiles, the status filter, pagination (10/page), the division
// grouping, and the per-user "Needs Attention" scoping in ONE place guarantees
// the tiles, filters, and pagination always agree (they read the same derived
// section list). Pure + deterministic so it is unit-testable without a DO.
//
// Status derivation MUST match the mock's `statusMeta` exactly so counts and pills
// agree: flags>0 -> Flagged; else doneCount>=6 -> Approved; else doneCount===0 ->
// Not started; else In review. The six dots = the six pipeline stages completed.

export interface OverviewSectionInput {
  section: string;
  title: string;
  role: string;
  draftingMode: string;
  status: string; // ManualDO per-section status string
  openFlags: number;
  error?: string;
}

export type StatusKey = 'approved' | 'in-review' | 'flagged' | 'not-started';
export type FilterKey = 'all' | 'approved' | 'in-review' | 'flagged' | 'not-started' | 'assigned-to-me';

// The six per-section pipeline stages (Draft · Resolve · Validate · Coordinate ·
// Compliance · Emit). A section's status string maps to how many are complete —
// the `doneCount of 6` the mock renders as status dots. `include` (front-end docs)
// and any terminal 'complete'/'done' status count as all six.
const STAGE_DONE: Record<string, number> = {
  pending: 0,
  queued: 0,
  drafting: 1,
  drafted: 1,
  resolving: 2,
  resolved: 2,
  validating: 3,
  validated: 3,
  coordinating: 4,
  coordinated: 4,
  compliance: 5,
  emitting: 5,
  complete: 6,
  done: 6,
};

export function doneCountFor(input: OverviewSectionInput): number {
  // An 'include' front-end doc is inserted unaltered — treat as fully done once the
  // run has reached it (status not pending). Otherwise map the run status.
  if (input.draftingMode === 'include' && input.status !== 'pending') return 6;
  const d = STAGE_DONE[input.status];
  return d == null ? 0 : d;
}

export function statusKeyFor(input: OverviewSectionInput): StatusKey {
  const flags = input.openFlags ?? 0;
  if (flags > 0) return 'flagged';
  if (doneCountFor(input) >= 6) return 'approved';
  if (doneCountFor(input) === 0) return 'not-started';
  return 'in-review';
}

const STATUS_LABEL: Record<StatusKey, string> = {
  approved: 'Approved',
  'in-review': 'In review',
  flagged: 'Flagged',
  'not-started': 'Not started',
};

// A small CSI division-name map for the group headers. Not licensed CSI IP — these
// are the generic division titles; unknown divisions fall back to "Division NN".
const DIVISION_NAME: Record<string, string> = {
  '00': 'Procurement & Contracting Requirements',
  '01': 'General Requirements',
  '02': 'Existing Conditions',
  '03': 'Concrete',
  '04': 'Masonry',
  '05': 'Metals',
  '06': 'Wood, Plastics & Composites',
  '07': 'Thermal & Moisture Protection',
  '08': 'Openings',
  '09': 'Finishes',
  '10': 'Specialties',
  '11': 'Equipment',
  '12': 'Furnishings',
  '13': 'Special Construction',
  '14': 'Conveying Equipment',
  '21': 'Fire Suppression',
  '22': 'Plumbing',
  '23': 'Heating, Ventilating & Air Conditioning',
  '25': 'Integrated Automation',
  '26': 'Electrical',
  '27': 'Communications',
  '28': 'Electronic Safety & Security',
  '31': 'Earthwork',
  '32': 'Exterior Improvements',
  '33': 'Utilities',
};

export function divisionOf(section: string): string {
  const t = section.trim();
  const m = t.match(/^(\d{2})/);
  return m ? m[1] : '00';
}
export function divisionName(division: string): string {
  return DIVISION_NAME[division] ?? `Division ${division}`;
}

export interface OverviewSection {
  section: string;
  title: string;
  role: string;
  draftingMode: string;
  division: string;
  statusKey: StatusKey;
  statusLabel: string;
  doneCount: number;
  flags: number;
  pendingOpen: number; // "N open" — open selections/flags awaiting the reviewer
  assignedToMe: boolean;
  assignees: { userId: string; userName: string }[];
  error?: string;
}

export interface OverviewResult {
  tiles: { approved: number; inReview: number; flagged: number; notStarted: number; assignedToMe: number; total: number };
  progress: { approved: number; total: number };
  filter: FilterKey;
  page: number;
  pageSize: number;
  totalFiltered: number;
  totalPages: number;
  showing: { from: number; to: number; of: number };
  divisions: { division: string; name: string; counts: { sections: number; approved: number; flagged: number }; sections: OverviewSection[] }[];
  needsAttention: { section: string; title: string; flags: number }[];
}

export interface DeriveArgs {
  sections: OverviewSectionInput[];
  assignedToMe: Set<string>; // sections assigned to the CURRENT user
  assigneesBySection: Map<string, { userId: string; userName: string }[]>;
  filter?: FilterKey;
  page?: number;
  pageSize?: number;
  pendingOpenBySection?: Map<string, number>; // optional: open decisions per section
}

export function deriveManualOverview(args: DeriveArgs): OverviewResult {
  const pageSize = args.pageSize ?? 10;
  const filter: FilterKey = args.filter ?? 'all';

  // 1. Enrich every section once (the single source the tiles/filter/pages share).
  const all: OverviewSection[] = args.sections.map((s) => {
    const statusKey = statusKeyFor(s);
    const division = divisionOf(s.section);
    return {
      section: s.section,
      title: s.title,
      role: s.role,
      draftingMode: s.draftingMode,
      division,
      statusKey,
      statusLabel: STATUS_LABEL[statusKey],
      doneCount: doneCountFor(s),
      flags: s.openFlags ?? 0,
      pendingOpen: args.pendingOpenBySection?.get(s.section) ?? (s.openFlags ?? 0),
      assignedToMe: args.assignedToMe.has(s.section),
      assignees: args.assigneesBySection.get(s.section) ?? [],
      error: s.error,
    };
  });

  // 2. Tiles (global, over ALL sections — not the filtered/paged view).
  const tiles = {
    approved: all.filter((s) => s.statusKey === 'approved').length,
    inReview: all.filter((s) => s.statusKey === 'in-review').length,
    flagged: all.filter((s) => s.statusKey === 'flagged').length,
    notStarted: all.filter((s) => s.statusKey === 'not-started').length,
    assignedToMe: all.filter((s) => s.assignedToMe).length,
    total: all.length,
  };

  // 3. Filter (composes with the division grouping below).
  const filtered = all.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'assigned-to-me') return s.assignedToMe;
    return s.statusKey === filter;
  });

  // 4. Paginate the FILTERED list (filtering resets to page 1 on the client).
  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const page = Math.min(Math.max(1, args.page ?? 1), totalPages);
  const start = (page - 1) * pageSize;
  const pageSections = filtered.slice(start, start + pageSize);

  // 5. Group the current page by division (hide empty divisions).
  const byDiv = new Map<string, OverviewSection[]>();
  for (const s of pageSections) (byDiv.get(s.division) ?? byDiv.set(s.division, []).get(s.division)!).push(s);
  const divisions = [...byDiv.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([division, secs]) => ({
      division,
      name: divisionName(division),
      counts: {
        sections: secs.length,
        approved: secs.filter((s) => s.statusKey === 'approved').length,
        flagged: secs.filter((s) => s.statusKey === 'flagged').length,
      },
      sections: secs,
    }));

  // 6. Needs Attention — flags ONLY from sections the current user is assigned to.
  const needsAttention = all
    .filter((s) => s.assignedToMe && s.flags > 0)
    .map((s) => ({ section: s.section, title: s.title, flags: s.flags }));

  return {
    tiles,
    progress: { approved: tiles.approved, total: tiles.total },
    filter,
    page,
    pageSize,
    totalFiltered,
    totalPages,
    showing: { from: totalFiltered === 0 ? 0 : start + 1, to: Math.min(start + pageSize, totalFiltered), of: totalFiltered },
    divisions,
    needsAttention,
  };
}
