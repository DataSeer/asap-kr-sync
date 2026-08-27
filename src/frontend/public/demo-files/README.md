# Demo files

This directory holds the demo manuscripts (PDFs + matching DS1 / KRT spreadsheets) used by the "try demo" flows in `PDFView.vue` / `KRTView.vue`, and by the maintenance scripts in `scripts/` (`generate-demo-data.js`, `benchmark-detections.js`, `fix-demo-materials-resource-types.js`).

The files themselves are **not tracked in git** — they're real research manuscripts and add ~470 MB to the repo. Drop them into this directory manually before:

- running `npm run build` (the frontend bundles `public/` into `dist/`),
- building the production Docker image (the build context must contain them),
- exercising the demo flows in dev (Vite serves `public/` directly).

Without these files, the rest of the app still works — clicking a demo link in the UI just 404s, and the helper scripts report no manuscripts found.

## File-naming convention

For a manuscript with id `XYZ-000123-001-org-A-1`:

| File | Purpose |
|---|---|
| `XYZ-000123-001-org-A-1.pdf` | The manuscript PDF |
| `XYZ-000123-001-org-A-1-DS1.xlsx` | DS1 compliance audit (parsed by `generate-demo-data.js`) |
| `XYZ-000123-001-org-A-1.xlsx` / `.csv` | Optional KRT (Key Resources Table) — used by `benchmark-detections.js --no-krt-only` to filter |

The `-DS1` suffix is reserved for the audit report; do not name a PDF `*-DS1.pdf`.

## Keeping the KRTs clean

These files are dropped in per host and are **not tracked**, so a fix made on one
machine does not travel. Run the two checks on every host after dropping the
corpus in — they are idempotent, and both keep a backup of anything they touch:

```bash
node scripts/check-krt.js --dir src/frontend/public/demo-files          # report
node scripts/check-krt.js --dir src/frontend/public/demo-files --fix    # canonical spellings
node scripts/clean-demo-krts.js --dir src/frontend/public/demo-files    # the rest
```

The goal is **0 blocking errors**, so a demo submission reaches step 2 and goes
straight to *Continue* instead of stopping at the acknowledge modal. Warnings are
expected and never block — the current corpus has 129 of them across 1380 rows.

`clean-demo-krts.js` carries a per-row decision for each blocking error this
corpus has (an ambiguous resource type, a missing source, an identifier the
author left blank); it prints every judgement call it makes. A **new** manuscript
with a different problem will be reported as `manual` and needs a decision added
there rather than a silent guess.

Author KRTs are frequently **cp1252, not UTF-8** — both scripts detect the
encoding and write the same bytes back. Read a KRT with a plain
`readFileSync(f, 'utf-8')` and every `µ`, `–` and accented character becomes
`U+FFFD` the moment you write it out again.
