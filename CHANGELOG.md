# Changelog

What changed in ASAP KR-Sync, in plain language. Newest first.

Commit references are in brackets so an engineer can find the exact change.

---

## August 2026

### Detection quality — protocols and datasets

**Protocols are better recognised, and fewer wrong ones slip through.**
Computational and machine-learning work — model training, data analysis pipelines —
is now more reliably classified as Software/code instead of appearing in your
Protocols list. Measured on 16 manuscripts against the curators' own reports, this
found **1.6% more of the protocols they recorded**, without adding noise.
[`be76d78`, `28eeaa8`, `df08519`]

**The Datasets list is much shorter and more accurate.**
It used to produce about 2.2 rows for every dataset a curator actually recorded;
it now produces about 1.7. In practice that means **158 fewer rows to review**
across those 16 manuscripts while finding roughly the same datasets. Duplicate
entries for the same dataset are largely gone.
[`be76d78`, `28eeaa8`]

One deliberate exception: if a dataset is deposited in **two places** (for example
Zenodo *and* dbGaP), you will still see two rows — one per deposit. Each row can
only hold one identifier, so merging them would silently lose one.
[`be76d78`]

**Fewer mislabelled identifiers.** A ProteomeXchange accession was being recorded
in the DOI field in one of the examples that teaches the system. Corrected.
[`be76d78`]

### Protocol sources

**Protocol sources are now named properly.**
When a protocol carries an identifier from a known publisher — protocols.io, JoVE,
Nature Protocols, Bio-protocol, STAR Protocols, Current Protocols, Cold Spring
Harbor Protocols, MethodsX, Protocol Exchange — that publisher is used as the
SOURCE, and whatever the AI had guessed is kept in brackets after it:

> `Meyer et al., 2024` → `protocols.io (Meyer et al., 2024)`

The curated list is treated as more reliable than the AI's guess, but nothing you
wrote is discarded. [`c8d827a`]

**Protocols nobody listed are now picked up.** The app recognises protocol
publishers directly from a DOI or link in the manuscript, so a published protocol
can be found even when it has never been added to our reference lists. It will
not guess: publishers whose identifiers look like ordinary journal articles are
deliberately skipped. [`b22dab8`, `9d69234`]

### KRT Editor

**Suggested values now appear directly in empty cells.**
When the AI has a suggestion for a cell you have left blank, the proposed value is
shown in the cell in grey italics with a **✓ Use** button. You can accept it
without opening the suggestions panel. It is styled so it can never be mistaken
for a value you actually entered. [`3ddd148`]

**You can now see where a suggestion came from.**
Click the small module badge on any suggestion to open a dialog showing the exact
passage of the article each detector matched on, plus the reason it was suggested.
Modules that found nothing to quote are still listed, so the count always adds up.

Jumping to the exact spot in the PDF is not available yet — this shows the text.
[`900d678`]

### Documentation

**New: a complete KRT Editor reference** covering every feature of the table —
editing, quick actions, validation feedback, suggestion review, bulk operations,
change visualisation — and, importantly, what the editor deliberately does *not*
do on its own. See `docs/krt-editor.md`. [`40c7133`]

**New: a full list of everything the background analysis changes automatically.**
Fifteen transformations the pipeline applies without asking, and what it will
never infer. See `docs/background-modules.md`. [`40c7133`]

**Corrections.** Several documents were out of date and have been fixed:

- Materials detection was described as disabled. It is enabled and running. [`5a397ab`]
- Step 3 (Approve KRT) was described as using the same table as Steps 1 and 2. It
  uses a separate review-only table, so search, quick actions and bulk operations
  are not available there. [`40c7133`]
- The user guide described a "Quick N/A button" that does not exist. The real
  options are *No identifier exists* / *Identifier pending* for Identifier, and
  *None* for Source. [`40c7133`]
- The clickable legend on Step 3, which hides or shows changes by source
  (AI / Val / User), was undocumented. [`40c7133`]

---

## Notes on how changes are validated

Detection changes in this release were measured against the DS curators' own
reports across 16 demo manuscripts, not judged by eye. Where a result could not be
separated from normal run-to-run variation, it is stated as unconfirmed rather
than claimed as an improvement.

Full results: `tmp/krt-eval-2026-08/AB-testing-results-2026-08-12.md`.
