# Changelog

## What's new — 2 July 2026

### Easier to explore what the tool found

The **background process** panels — detected mentions, authors, the Generated
KRT (PDF Analysis) and AI Suggestions — are now much easier to read and search:

- **Search any table.** Type in the search box to instantly narrow a table to
  the rows you care about — and your search term is now **highlighted** wherever
  it appears, so matches are easy to spot at a glance.
- **Filter to what matters.** The Generated KRT and AI Suggestions tables get
  quick tab filters (All, Datasets, Software/code, Protocols, Key Lab Materials)
  with a count on each; the per-module mention tables keep a resource-type
  dropdown.
- **Filter suggestions by decision.** On the AI Suggestions table, toggle the
  **Add / Update / Remove / Skip** chips to show only the kinds of changes you
  want to review.
- **Tidier, scrollable tables.** Tables now scroll within a fixed height with
  their headers pinned, so you can always reach the logs below. Rows follow the
  same order as the KRT editor, and the suggestion name column is no longer
  cramped.

### Detection now waits for your validated KRT

- **Better-grounded results.** Dataset, protocol and lab-material detection use
  the rows in your KRT to guide their search, so they now **wait until you've
  validated your KRT** before running — you'll see *"Waiting for the Key
  Resources Table to be validated"* on those steps until then. Software, author
  and data-availability detection still start right away, so nothing else slows
  down.

### Faster, more reliable editing

- **Quicker saves.** Editing or fixing several cells at once now saves in a
  single step instead of one request per cell, so bulk changes apply faster and
  reliably.
- **Smoother session handling.** If your session expires, signing back in now
  returns you to the page you were on.

### Behind the scenes

- **Security & reliability hardening.** Following a full security review, we
  tightened usage limits, made file uploads and spreadsheet (CSV) exports safer,
  hardened login and session handling, and made multi-step saves all-or-nothing
  so a failure can never leave your data half-updated.

## KRT Assistant improvements — June 2026

A big update to how the tool detects resources, suggests changes, and lets you
edit your Key Resources Table.

### Smarter automatic detection

- **Software & code.** Results are cleaner: code written in a language (e.g. R,
  MATLAB) now appears as its own row marked **New**, general software defaults to
  **Reuse**, and instrument/acquisition software is no longer added as clutter.
  Software you already listed is no longer suggested again as a duplicate — even
  when your entry had a version number or RRID in its name.
- **Protocols.** More accurate: reagent suppliers and catalog numbers are no
  longer mistakenly attached to a protocol, protocols.io links and method
  citations are captured, and your own KRT protocols are used to guide the
  results. Plain data analyses are no longer mislabelled as protocols.
- **Lab materials.** Detection is now grounded on the materials you listed, so
  it stays focused and low-noise — and it is skipped entirely when you haven't
  provided any materials.

### A smarter "Generated KRT" and AI suggestions

- **The Generated KRT is now built with AI.** The tool gathers everything the
  detection modules found, then uses AI to consolidate it — merging duplicates,
  dropping items that aren't real resources, and tidying the fields — with a
  short **reason** explaining each row.
- **New "AI Suggestions" step.** A dedicated step compares your KRT against the
  generated one and proposes **Add / Update / Remove** changes. It prioritizes
  your data, keeps the list manageable, and only suggests a removal for a clear
  mistake. Each suggestion shows **which detection module it came from** and
  **why** it was proposed.
- **Suggestions are saved and refresh on their own.** They no longer change
  silently while you edit; they update automatically after a module re-runs, and
  you can rebuild them anytime with the **Regenerate suggestions** button.
- **AI Suggestions appears in the process list** like the other modules, with a
  summary of every choice it made (and the reason for each).

### Easier KRT editing

- **Resizable columns.** Drag a column's edge to widen it; the size is remembered
  for next time.
- **Quick dropdowns.** Change **Resource Type** and **New/Reuse** right in the
  row, without opening the edit pop-up.
- **Merge rows.** Select two or more rows and combine them into one, choosing
  which value to keep for each column.
- **One-click resource-type fixes.** When several rows use a non-standard type
  (e.g. "Code", "Software"), fix them all at once (e.g. "Set 4 → Software/code").
- **QC / Optional flags.** Rows can be marked as QC or Optional. These fields are
  visible only to Administrators and DS Annotators; other users see the table as
  before.

### Clearer background-process details

- The **PDF Analysis** view now shows the reason each row was kept or merged,
  lists the items that were **dropped** (with reasons), and uses a clear
  **"KRT #"** grouping so you can see when several detections were combined into
  a single row.

### Behind the scenes

- Security: known dependency vulnerabilities were patched.
- Documentation was updated to match the new workflow and modules.
