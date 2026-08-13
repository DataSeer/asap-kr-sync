# Design proposal — Grounding vs Discovery: KRT detection with or without an author table

**Status:** proposal · **Branch:** `feat/krt-detection-two-modes` · **Created:** 2026-08-12
**Companion notes:** `tmp/suggestions-quality/DESIGN-rank-not-filter.md`, `tmp/suggestions-quality/IDEA-location-aware-krt.md`
**Evidence base:** `tmp/krt-eval-2026-08/KRT-detection-evaluation-2026-08-10.md`, `AB-testing-results-2026-08-12.md`

---

## 1. The requirements, stated precisely

The app assists KRT creation. Two usage modes:

- **Mode A — author provides a KRT** (the default, expected way).
- **Mode B — no KRT provided.**

And in both modes, two distinct jobs:

- **Job G — Grounding.** For every resource the KRT references, find it in the PDF and recover
  its name + source + identifier (the identifying fields differ per resource type).
- **Job D — Discovery.** Find the resources the author *missed* — present in the manuscript,
  absent from the KRT.

These are not two views of one task. They have opposite information flow:

| | Job G — Grounding | Job D — Discovery |
|---|---|---|
| Input | a known item, searched for | an unknown document, swept |
| Shape | targeted retrieval | open extraction |
| Failure | "not found in the text" — **itself a finding** | a missed resource |
| Metric | per-row confirmation rate | recall / precision |
| Wants | precision, evidence | recall, ranking |

---

## 2. Diagnosis — why the current design cannot satisfy either job

Today the author KRT is injected into the detection prompt as *authoritative seeds*
(`services/krt/author-krt-seeds.service.js` → Section 0 of the datasets / materials / protocols
prompts). One LM call is asked to do Job G and Job D simultaneously. Three consequences:

### 2.1 Grounding is unverifiable — seed and answer share one channel

`materials-detection.txt`: *"SEED FIRST. Emit one output row for every author-provided material.
Never drop one."* The model can copy a seed straight to the output without ever looking at the
manuscript, and **the output looks identical either way**. There is no field that distinguishes
*"I found this in the text"* from *"I echoed what you gave me."*

So the app currently **cannot answer the primary requirement**: is this KRT row actually
supported by the PDF?

### 2.2 Discovery is explicitly suppressed

The same prompts instruct: *"ADD SPARINGLY … When in doubt, do NOT add it."* Job D is
demoted to an afterthought inside a call whose stated priority is echoing seeds. Worse,
`materials.service.js:133` **skips the Gemini call entirely** when the author listed no materials —
discovery capacity for that category is exactly zero in Mode B.

### 2.3 Measurement is impossible on the production path

Both eval reports had to run **article-only, no seeding** to measure genuine discovery. That is an
admission that the shipped path's recall is unknowable. Any A/B on the seeded path measures
echo fidelity, not detection quality.

### 2.4 Mode B is a special case bolted onto Mode A

Detection gates on `krt_curated` and waits for KRT validation. With no KRT the pipeline is
running prompts whose entire Section 0 is dead text, with no grain reference and no ranking —
so every candidate becomes an `add` and the curator is flooded.

---

## 3. The proposal — separate the two jobs, make detection KRT-blind

```
                    ┌──── Pass D — DISCOVERY (KRT-blind, always runs) ─────────┐
PDF → markdown ─────┤  candidate sweep → classification, evidence-grounded     │
                    └────────────────────────────┬────────────────────────────┘
                                                 │  Candidate pool
                                                 │  every candidate carries an evidence span
                    author KRT (if any) ─────────┤
                                                 ↓
                    ┌──── Pass G — GROUNDING / MATCHING ──────────────────────┐
                    │  deterministic match first (identifier → alias → name)   │
                    │  unmatched author rows → targeted LM second look         │
                    └────────────────────────────┬────────────────────────────┘
                                                 ↓
                    ┌──── Reconciliation → suggestions ───────────────────────┐
                    │  author row confirmed   → nothing                        │
                    │  author row incomplete  → update (fill missing field)    │
                    │  author row unsupported → flag (new capability)          │
                    │  candidate unmatched    → add, ranked                    │
                    └─────────────────────────────────────────────────────────┘
```

**The single design rule: the author KRT is a query, never a seed.**

It enters the pipeline *after* detection, as the thing candidates are matched against and as the
source of targeted searches — never as prompt content that the detector is told to reproduce.

### Why this satisfies both modes with one code path

Mode B is not a special case. It is the same pipeline with an **empty match set**: every candidate
falls through to `add`. The difference between modes moves out of *detection* and into
*reconciliation and presentation*, which is where it belongs.

---

## 4. The enabling contract change — evidence spans

`KrtEntry` gains a required field:

```jsonc
"evidence": {
  "quote":   "…exact substring of the manuscript markdown…",  // validated server-side
  "offset":  14832,                                            // char offset
  "section": "Methods > Immunohistochemistry"                  // from the sectioniser
}
```

Rules:

- Every candidate from every detector must carry one. A candidate whose `quote` is **not** an exact
  substring of the markdown is dropped before it reaches the pool (cheap, deterministic
  hallucination control — the only such control the pipeline would have).
- Identifier-scan candidates get this for free (`known-identifier-scanner` already records
  `position` + an 80-char context).
- Datasets pass 1 (LangExtract) already produces grounded spans — the contract generalises what
  that detector proved works.

Evidence is what makes Job G answerable, what makes used-vs-cited judgeable
(`IDEA-location-aware-krt.md`), and what a curator needs in order to trust a row.

---

## 5. Job G — how matching works

### 5.1 Per-type identifying keys, tried in order

Matching is mostly deterministic and mostly already built
(`merge-detections.service.js`, `identifier-normalize.service.js`). What is missing is an explicit,
shared per-type key hierarchy, used by **both** the matcher and the second-look query builder:

| Resource type | Key 1 | Key 2 | Key 3 |
|---|---|---|---|
| Software/code | `RRID:SCR_…` | repo / registry URL (GitHub, PyPI, CRAN, Bioconductor) | version-stripped name |
| Dataset | accession (GSE/SRR/PXD/PRJNA/phs/E-MTAB/PDB/EMD…) | data-repository DOI (Zenodo, Figshare, Dryad) | repository + name |
| Protocol | protocols.io DOI / venue DOI | cited-method DOI | section-heading text |
| Lab material | `RRID:AB_/CVCL_/IMSR_/Addgene_` | vendor + catalog number | target + host species |

### 5.2 The three outcomes for an author row

| Outcome | Condition | Suggestion |
|---|---|---|
| **Confirmed** | matched a candidate; identifiers agree | none |
| **Incomplete** | matched, but the KRT row lacks a source/identifier the text supplies (or the text supplies a different one) | `update` — fill the empty field only, never overwrite |
| **Unsupported** | no candidate matched, and the targeted second look found nothing | **flag for review** — never auto-remove |

**"Unsupported" is new capability and is arguably the most valuable output of this design.**
It answers a question ASAP actually cares about: *does the manuscript cite the resources its KRT
claims?* Today the app cannot produce it. The eval already stumbled on the phenomenon — roughly a
third of removed author antibodies "are not in the article text at all" — where it currently reads
as noise in a recall metric rather than as a finding.

### 5.3 The targeted second look

For author rows with no deterministic match, one batched LM call per resource type:

> Here are N resources from the author's Key Resources Table. For each, search the manuscript
> and return the exact sentence that mentions it, plus any catalog number, RRID, accession,
> version, dilution or supplier appearing near it. If a resource is genuinely absent from the
> manuscript, say so explicitly. Never invent a quote.

This is the *right* use of the author KRT: high precision, cheap, verifiable (the quote must be a
real substring), and it recovers exactly the naming-variant misses the eval documented
(`Cell Profiler`/`CellProfiler`, `ImageJ/FIJI`).

---

## 6. Mode B — no author KRT

Three additions, none of which affect Mode A:

1. **Recover the in-document KRT.** Many manuscripts carry a resource/reagent table in the
   supplemental — the LangExtract examples show spans like `Dataset | GEO | This paper | GSE328400 | NEW`.
   A dedicated pass that finds and parses any such table yields *author-asserted rows* with near-perfect
   precision, which then flow into Pass G as if they had been uploaded. This partially converts Mode B
   into Mode A. (Note: the References cutoff currently deletes this surface on Docling output —
   see `KNOWN_ISSUES.md`.)
2. **The DAS becomes the anchor.** With no KRT, the Data/Code Availability Statement is the author's
   claim about what exists. Grounding the DAS against the candidate pool gives targeted gaps:
   *"the DAS says RNA-seq was deposited in GEO; no accession appears anywhere in the manuscript."*
   Same Job-G machinery, different query source.
3. **Ranking becomes mandatory, not optional.** Everything is an `add`, so the funnel must order
   rather than threshold — this is precisely `DESIGN-rank-not-filter.md`, and Mode B is the case
   that forces it.

---

## 7. Consequences for the pipeline

- **The `krt_curated` gate disappears** from `datasets_detection`, `materials_detection`,
  `protocols_detection`. Detection is KRT-blind, so it can run immediately after `markdown_convert`.
  Results arrive sooner and the pipeline no longer stalls on a KRT that may never arrive.
- **Materials always runs.** The `no_author_materials` early return is deleted.
  (Cf. ticket 0040 — same direction.)
- **The seeding service** (`author-krt-seeds.service.js`) moves from *detection* to *reconciliation*.
  If grain calibration proves valuable, it belongs in the consolidation stage as style examples —
  never as "never drop these".
- **Suggestion generation** keeps its shape but gains the third outcome (`unsupported`) and consumes
  a match result instead of re-deriving one, which should also shrink the truncation pressure on
  `krt-comparison.txt`.

---

## 8. Staged plan

| # | Step | Unlocks | Measurable by |
|---|---|---|---|
| 1 | Evidence-span contract on `KrtEntry` + server-side substring validation | everything below | span-validity rate per detector |
| 2 | Un-seed the three detectors; drop the `krt_curated` gate; materials always runs | one code path for both modes | direct A/B — the existing article-only numbers **are** the baseline |
| 3 | Per-type key hierarchy + deterministic matcher + three-outcome reconciliation | Job G, honestly | confirmation rate on the 16 ground-truth manuscripts |
| 4 | Targeted second look for unmatched author rows | naming-variant recovery | drop in `unsupported` count |
| 5 | Ranking for Mode B | usable no-KRT experience | precision@10 against curated reports |

Steps 1–2 are prerequisites for trusting any later measurement. Decoding hygiene
(`temperature: 0`, `responseSchema`) should land with step 1 — the A/B report measured a
34-vs-3-row swing on identical inputs, which is noise large enough to hide any of these effects.

---

## 9. Open questions

1. **Is "unsupported author row" a finding ASAP wants surfaced?** It is compliance-relevant
   (the KRT should reflect the manuscript) but it is also the app telling an author they are wrong,
   which cuts against "assist, do not correct". Needs a product call before step 3 ships.
2. **Protocol granularity** (DS question 1, still unanswered) — affects Job D volume in both modes,
   and in Mode B there is no author grain to calibrate against.
3. **Does grain calibration from the author KRT earn its keep** once seeding is removed from
   detection? Measurable in step 2 as a side experiment, not an assumption.

---

## 10. Implementation status (2026-08-12)

Built on `feat/krt-detection-two-modes`. Steps 1–4 of §8 are implemented; step 5 (ranking for Mode B) is not.

| § | Item | Where |
|---|---|---|
| 4 | Evidence contract + deterministic grounding of every claim | `services/pdf-analysis/evidence.service.js`, `krt-entry.js` |
| 3 | Detection made KRT-blind; `krt_curated` gate moved off the detectors | the three detector services, `queue/orchestrator.service.js` |
| 3 | Materials always runs (the `no_author_materials` early return is gone) | `services/materials/materials.service.js` + rewritten cue-driven prompt |
| 5 | Per-type key hierarchy + matcher + three outcomes | `services/krt-grounding/match-author-rows.service.js` |
| 5.3 | Targeted LM second look, with every quote re-verified | `services/krt-grounding/krt-grounding.service.js` |
| 6 | Outcomes → suggestions (`incomplete` → fill) and tags (`not_detected` → badge) | `services/suggestion/kr-comparison.service.js`, `KRTEditor.vue` |

**Deliberately not built:** ranking for Mode B (§6.3), the in-document KRT recovery pass (§6.1), and the DAS-as-anchor
grounding (§6.2). Each is independently useful and none is a prerequisite for the above.

### Decoding: what was actually found

§8 recommended setting `temperature: 0` before measuring anything. On inspection **no temperature has ever been set
anywhere in this codebase** — the two commits that appear in `git log -S temperature` are a prompt example containing
the words "body temperature" and the initial import. Every Gemini call therefore runs at the API default of 1.0.
This was an omission, not a decision, and it is the most likely cause of the 34-vs-3-row swing on identical inputs in
`AB-testing-results-2026-08-12.md`.

`thinkingBudget: 0` **was** deliberate — commit `38a16db` set it on the three detectors to stop JSON truncation, and
its own message says *"Extraction tasks don't need thinking; re-enable if quality regresses."*

Neither has been changed, pending a decision. What *was* fixed is the related defect in the same family:
`kr-comparison` passed **no generation config at all** while its prompt demands one decision per generated ref and
carries a "COMPLETENESS IS MANDATORY" paragraph written because the response was truncating. It now sets
`responseMimeType`/`maxOutputTokens`/`thinkingBudget` like the detectors, and logs `MAX_TOKENS` explicitly.
