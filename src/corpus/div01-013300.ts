// Division 01 master section 01 33 00 "Submittal Procedures". The manual is where
// Division 01 becomes real: it governs every technical section and anchors the
// manual-scope "Div 01 vs General Conditions" and "submittal-mismatch"
// cross-checks. Drafted like any other section through the per-section pipeline.
//
// Illustrative placeholder content. It deliberately reflects only Product Data +
// Samples (NOT the VOC Compliance Certificate the Painting section requests) so
// the manual-scope "submittal-mismatch" cross-check demonstrably fires.

import type { SectionIR } from '../shared/types';

export function div0133SubmittalProcedures(): SectionIR {
  return structuredClone({
    section: '01 33 00',
    title: 'Submittal Procedures',
    tagProfile: 'plain',
    parts: [
      {
        part: 1,
        title: 'GENERAL',
        articles: [
          {
            id: '1.1',
            title: 'SUMMARY',
            paragraphs: [
              {
                id: '1.1.A',
                text:
                  'This Section specifies the general requirements and procedures for submittals required of the Contractor. Requirements of individual technical sections govern where more stringent.',
                sourceRef: 'builtin:01 33 00:1.1',
                locked: false,
                mandatory: false,
                criteriaRef: 'cid-p100-finishes',
              },
            ],
          },
          {
            id: '1.2',
            title: 'SUBMITTAL PROCEDURES',
            paragraphs: [
              {
                id: '1.2.A',
                text: 'Transmit each submittal to the Contracting Officer using the agency transmittal form. The following submittal categories are administered by this Section:',
                sourceRef: 'builtin:01 33 00:1.2',
                locked: false,
                mandatory: false,
                // Div 01 administers Product Data + Samples but NOT the VOC
                // Compliance Certificate — the technical Painting section requests
                // it, so the manual-scope submittal-mismatch check fires.
                subRequests: [{ item: 'Product Data' }, { item: 'Samples' }],
                submittals: [],
              },
              {
                id: '1.2.B',
                text:
                  'Action submittals will be reviewed and returned with an action stamp. No portion of the Work requiring a submittal shall commence until the submittal has been returned marked to permit the Work to proceed.',
                sourceRef: 'builtin:01 33 00:1.2',
                locked: false,
                mandatory: true, // "shall" — a mandatory span (G2)
              },
            ],
          },
        ],
      },
    ],
  } satisfies SectionIR);
}
