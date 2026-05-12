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
