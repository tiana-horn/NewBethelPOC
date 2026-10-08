// UFGS master section 09 90 00 "Paints and Coatings" (Mode A source corpus).
//
// In production this is a chunked UFGS XML in R2 -> Vectorize `ufgs` (§4). For
// the POC it is a typed Section IR so the shape is compile-checked and the
// deterministic Drafter is reproducible. It intentionally contains:
//   • option brackets [ ] (substrate, sheen) and a fill [_____] (VOC limit)
//   • mandatory + locked "shall" spans (1.3.A, 3.1.A) — G2
//   • a tailoring-controlled paragraph (1.3.B, agency axis) — G3
//   • reference requests incl. ASTM D3960 (NOT in the seeded UMRL) — G1
//   • submittal requests incl. SD-06 Adhesion Test Reports (NOT in UMSL) — G1

import type { SectionIR } from '../shared/types';

export function ufgsPainting(): SectionIR {
  return structuredClone(MASTER);
}

const MASTER: SectionIR = {
  section: '09 90 00',
  title: 'Paints and Coatings',
  tagProfile: 'specsintact',
  parts: [
    {
      part: 1,
      title: 'GENERAL',
      articles: [
        {
          id: '1.1',
          title: 'REFERENCES',
          paragraphs: [
            {
              id: '1.1.A',
              text:
                'The publications listed below form a part of this specification to the extent referenced. The publications are referred to within the text by the basic designation only.',
              sourceRef: 'ufgs:09 90 00:1.1',
              locked: false,
              mandatory: false,
              // Six of these resolve against the seeded UMRL; ASTM D3960 does not
              // and must be FLAGGED by the Validator (G1), never invented.
              refRequests: [
                { org: 'ASTM', designation: 'ASTM D16' },
                { org: 'ASTM', designation: 'ASTM D4258' },
                { org: 'ASTM', designation: 'ASTM D3960' },
                { org: 'MPI', designation: 'MPI 43' },
                { org: 'MPI', designation: 'MPI 54' },
                { org: 'SSPC-AMPP', designation: 'SSPC-SP 1' },
                { org: 'SSPC-AMPP', designation: 'SSPC-SP 3' },
              ],
              references: [],
            },
          ],
        },
        {
          id: '1.2',
          title: 'SUBMITTALS',
          paragraphs: [
            {
              id: '1.2.A',
              text:
                'Government approval is required for submittals with a "G" classification. Submit the following in accordance with Section 01 33 00 SUBMITTAL PROCEDURES:',
              sourceRef: 'ufgs:09 90 00:1.2',
              locked: false,
              mandatory: false,
              // SD-06 Adhesion Test Reports is NOT in the seeded UMSL -> FLAG (G1).
              subRequests: [
                { sdCode: 'SD-03', item: 'Coating Products', classification: 'G' },
                { sdCode: 'SD-04', item: 'Samples', classification: 'G' },
                { sdCode: 'SD-06', item: 'Adhesion Test Reports', classification: 'G' },
                { sdCode: 'SD-07', item: 'VOC Compliance Certificate', classification: 'S' },
              ],
              submittals: [],
            },
          ],
        },
        {
          id: '1.3',
          title: 'QUALITY ASSURANCE',
          paragraphs: [
            {
              id: '1.3.A',
              text:
                'Applicators shall have not less than three years documented experience in work of the type and scope specified in this Section.',
              sourceRef: 'ufgs:09 90 00:1.3',
              locked: true, // G2: immutable "shall" span
              mandatory: true,
            },
            {
              id: '1.3.B',
              text:
                'Conduct coating operations in accordance with USACE EM 385-1-1 safety and health requirements.',
              sourceRef: 'ufgs:09 90 00:1.3',
              locked: false,
              mandatory: false,
              // G3: governed by the AGENCY tailoring axis, NOT by a bracket.
              tailoring: {
                requirementId: 'qa-safety-agency',
                axis: 'agency',
                includeWhen: { agency: 'ARMY' },
              },
            },
          ],
        },
      ],
    },
    {
      part: 2,
      title: 'PRODUCTS',
      articles: [
        {
          id: '2.1',
          title: 'MATERIALS',
          paragraphs: [
            {
              id: '2.1.A',
              text: 'Provide interior coating systems for {{b-substrate}} substrates as scheduled.',
              sourceRef: 'ufgs:09 90 00:2.1',
              locked: false,
              mandatory: false,
              selections: [
                {
                  id: 'b-substrate',
                  kind: 'option',
                  requirementId: 'substrate-scope',
                  note: 'Note to the Designer: select applicable substrates from the finish schedule.',
                  options: ['gypsum board', 'concrete', 'ferrous metal', 'wood'],
                  resolved: null,
                },
              ],
            },
            {
              id: '2.1.B',
              text:
                'Interior latex coatings shall conform to MPI 43 (eggshell) and MPI 54 (semi-gloss) as applicable, and terminology shall be as defined in ASTM D16.',
              sourceRef: 'ufgs:09 90 00:2.1',
              locked: true, // mandatory product-conformance span
              mandatory: true,
              criteriaRef: 'cid-ufc-fmt', // links to the UFC criteria clause (G7)
            },
            {
              id: '2.1.C',
              text: 'Maximum VOC content of interior coatings shall not exceed {{b-voc}} g/L.',
              sourceRef: 'ufgs:09 90 00:2.1',
              locked: false,
              mandatory: false,
              selections: [
                {
                  id: 'b-voc',
                  kind: 'fill',
                  requirementId: 'voc-limit',
                  note: 'Note to the Designer: insert the maximum VOC content from the project sustainability criteria.',
                  value: null,
                },
              ],
            },
            {
              id: '2.1.D',
              text: 'Sheen on gypsum board wall and ceiling surfaces: {{b-sheen-gwb}}.',
              sourceRef: 'ufgs:09 90 00:2.1',
              locked: false,
              mandatory: false,
              selections: [
                {
                  id: 'b-sheen-gwb',
                  kind: 'option',
                  requirementId: 'sheen-gwb',
                  note: 'Note to the Designer: select sheen for gypsum board surfaces.',
                  options: ['flat', 'eggshell', 'satin', 'semi-gloss'],
                  resolved: null,
                },
              ],
            },
            {
              id: '2.1.E',
              text: 'Sheen on ferrous metal surfaces: {{b-sheen-metal}}.',
              sourceRef: 'ufgs:09 90 00:2.1',
              locked: false,
              mandatory: false,
              selections: [
                {
                  id: 'b-sheen-metal',
                  kind: 'option',
                  requirementId: 'sheen-metal',
                  note: 'Note to the Designer: select sheen for ferrous metal surfaces.',
                  options: ['flat', 'eggshell', 'satin', 'semi-gloss'],
                  resolved: null,
                },
              ],
            },
          ],
        },
      ],
    },
    {
      part: 3,
      title: 'EXECUTION',
      articles: [
        {
          id: '3.1',
          title: 'EXAMINATION',
          paragraphs: [
            {
              id: '3.1.A',
              text:
                'The Contractor shall examine surfaces scheduled to receive coatings and shall not begin application until unsatisfactory conditions have been corrected.',
              sourceRef: 'ufgs:09 90 00:3.1',
              locked: true, // G2
              mandatory: true,
            },
          ],
        },
        {
          id: '3.2',
          title: 'PREPARATION',
          paragraphs: [
            {
              id: '3.2.A',
              text:
                'Prepare ferrous metal surfaces in accordance with SSPC-SP 1 (solvent cleaning) and SSPC-SP 3 (power tool cleaning).',
              sourceRef: 'ufgs:09 90 00:3.2',
              locked: false,
              mandatory: false,
            },
            {
              id: '3.2.B',
              text:
                'Prepare gypsum board surfaces by removing dust and ensuring surfaces are dry and free of defects prior to coating.',
              sourceRef: 'ufgs:09 90 00:3.2',
              locked: false,
              mandatory: false,
            },
          ],
        },
        {
          id: '3.3',
          title: 'APPLICATION',
          paragraphs: [
            {
              id: '3.3.A',
              text:
                'Apply coatings in accordance with the manufacturer’s printed instructions and the applicable MPI system for each substrate and sheen.',
              sourceRef: 'ufgs:09 90 00:3.3',
              locked: false,
              mandatory: false,
            },
          ],
        },
      ],
    },
  ],
};
