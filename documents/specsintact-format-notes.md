# SpecsIntact SEC Format — Notes & Corpus Facts

**Status:** authoritative for the SEC on-disk format. Where this document and
CHANGE-06 §2.3 disagree, **this document wins** — it is derived from real
NASA-KSC master sections, not from secondary web sources.

**For Claude Code:** treat this as an erratum to CHANGE-06 §2.3. The validation
target is an **XSD, not a DTD**. Do not "correct" this back to a DTD from web
search — the primary evidence (the committed `.sec` fixtures) is decisive, and
several public summaries are wrong because SpecsIntact's `.SEC` extension
collides with the U.S. Securities and Exchange Commission and with SpecsIntact's
own pre-XML SGML heritage.

---

## 1. The ruling: XSD, not DTD

Every SEC section in the NASA-KSC master download is XML that declares an XSD via
`xsi:noNamespaceSchemaLocation` and contains **no `<!DOCTYPE>`**. The DTD belongs
to SpecsIntact's legacy SGML era and does not describe the current on-disk files.

Verified across **all 17** `.sec` files in the download (100% uniform):

| Property | Value |
|---|---|
| Root element | `<SEC>` |
| Schema decl | `xsi:noNamespaceSchemaLocation="http://si.ksc.nasa.gov/sidownloads/xml/specsintactSEC.xsd"` |
| `<!DOCTYPE>` present | none (0 of 17) |
| `.dtd` reference anywhere | none (0 of 17) |
| Encoding | `windows-1252` (0 of 17 UTF-8) |
| Line endings | CRLF (`\r\n`) |
| Subformat marker | `<MTA NAME="SUBFORMAT" CONTENT="NEW"/>` |

This holds across all three numbering styles present in the corpus, so it is not
a per-vintage quirk:
- modern six-digit MasterFormat 2004 — `01 33 00`
- legacy five-digit — `01420` (in `01_42_00.sec`)
- MasterFormat 1995 `.00 98` convention — the `_98` filenames

## 2. The XSD is referenced but not distributed — OPEN item

`specsintactSEC.xsd` is named by URL in every section but is **not shipped in the
master download** and is not retrievable from the open web (the declared host
`si.ksc.nasa.gov` is an old hostname; the SpecsIntact site blocks automated
fetches). "No `.xsd` in the package" and "the format uses an XSD" are both true —
the schema is an external reference, never bundled.

Ways to obtain the authoritative schema, in order of likelihood:
1. Open the schema-location URL in a browser; try `https://` and the
   `specsintact.ksc.nasa.gov` host variant.
2. Extract it from a SpecsIntact software install (the editor validates locally,
   so it holds a copy).
3. Ask the NASA desk: KSC-SpecsIntact@nasa.gov.

Until retrieved, **`specsintactSEC.xsd` stays an explicitly open item.** Do **not**
commit a fabricated or corpus-inferred schema under `documents/` as if it were the
authoritative NASA XSD — that would be a false-completeness (G-MAN violation).

## 3. Interim validation for §2.3 (does not need the authoritative XSD)

The point of §2.3 is emitter fidelity, and the real corpus proves that more
strongly than a schema does. Required checks:

1. **Well-formedness** — emitted XML parses (`windows-1252`, CRLF preserved).
2. **Corpus round-trip (the real fidelity proof)** — parse a committed real
   `.sec` → internal IR → re-emit → canonical diff against the original.
   Normalize only insignificant differences (CRLF, `windows-1252` byte
   equivalence, insignificant whitespace between tags). Fail on structural drift.
3. **Optional schema gate** — if a schema check is wanted before the real XSD is
   in hand, generate an inferred XSD with `trang` or XMLBeans `inst2xsd` from the
   corpus, store it under a clearly non-authoritative path
   (e.g. `test/inferred/`), and label it "inferred, not the NASA schema."

Rename the §2.3 artifacts DTD→XSD (e.g. `test/specsintact-dtd.test.ts` →
`test/specsintact-xsd.test.ts`). The Part 8 round-trip-fidelity claim is honest
once (2) passes on real fixtures, and stays "open (authoritative XSD not
retrieved)" for the schema-validation sub-claim.

## 4. Observed element tags

The corpus uses these SpecsIntact element tags (counts across all 17 sections,
highest first): `BRK`, `TXT`, `SUB`, `TTL`, `SPT`, `RID`, `NPR`, `REF`, `PRT`,
`TAB`, `MTA`, `SEC`, `SCP`, `HDR`. Safe-to-rely-on structural roles: `SEC`
(section root), `HDR` (header block), `PRT` (Part), `SPT` (Subpart), `TTL`
(title), `TXT` (text), `TAB` (table), `BRK` (line break), `MTA` (metadata).
The **authoritative** element set and content model are defined by the
unretrieved XSD — which is exactly why round-trip against real files, not a
hand-built tag list, is the validation contract until the schema is obtained.

## 5. Corpus scope caveat

These 17 sections are the **NASA-KSC master** subset, not the full tri-service
UFGS master (~683 sections). They are excellent fidelity fixtures and cover the
numbering variety, but must not be mistaken for the complete corpus.

## 6. Companion master files (for ingest metadata)

- **`PULL.TBL`** — the master's section catalog. Caret-delimited, one row per
  section: `number ^ title ^ agency ^ edition/change ^ flag ^ timestamp ^ user ^^ ^ description`.
  Example: `01 33 00 ^ SUBMITTAL PROCEDURES ^ USACE ^ 08/18, CHG 4: 02/21 ^ … ^ general procedures regarding submittals…`.
  This is the section-selection index and `corpus_source` metadata (agency,
  edition, change) handed over directly — no scraping. Commit as reference.
- **`mf2004.hdr`** — master is on MasterFormat 2004 numbering.
- **`newsubfm.hdr`** — master uses unified submittal formatting (dated 4/21/2025).
- **`tailorRemove.tag`** — tailoring vocabulary (ALTITUDE / ARMY / NAVY / …);
  relevant only if `<TLR>` tailoring is processed.

## 7. Page-footer template (rescued from wmaster.dft)

The master's binary `wmaster.dft` embeds the page-footer template:

```
SECTION {section}  Page {page}
```

This is the footer the sealed PDF must reproduce, so it is relevant to the
render / pagination-fidelity gate (CHANGE-06 §6 / G16). **Record this fact here;
do not commit `wmaster.dft`.** The binary is opaque, the emitter never references
it, and it contains a NASA staffer's local Windows path
(`C:\Users\<user>\Documents\SpecsIntactWD\Masters\KSC`) — i.e. don't commit or
log it.

---

## Commit manifest

| File(s) | Action | Location |
|---|---|---|
| All 17 `*.sec` | Commit as fixtures | `test/fixtures/specsintact/` |
| `PULL.TBL` | Commit as reference | `documents/` (or corpus metadata dir) |
| `mf2004.hdr`, `newsubfm.hdr`, `tailorRemove.tag` | Optional context | `documents/` if tailoring/submittal in scope, else skip |
| `specsintactSEC.xsd` | **Do not commit** — not obtained; open item | — |
| `Properties.xml`, `wmaster.hdr`, `tagfix.log` | Skip (scaffolding / opaque / empty) | — |
| `wmaster.dft` | **Skip**; transcribe footer template into §7 first | — |
| This file | Commit | `documents/specsintact-format-notes.md` |
