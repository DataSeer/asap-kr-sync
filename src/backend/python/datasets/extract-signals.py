#!/usr/bin/env python3
"""
Dataset Signal Extraction Script

Extracts structured DATASET_ROW signals from manuscript markdown text
using the langextract library (Google).

Usage:
    cat article.md | python3 extract-dataset-signals.py \
        --prompt prompts/datasets-signals-extraction.txt \
        --examples prompts/datasets-signals-examples.json \
        [--model gemini-2.5-flash] \
        [--max-workers 60] \
        [--max-char-buffer 3000] \
        [--extraction-passes 1]

Input:  Markdown text via stdin
Output: JSON array of DATASET_ROW extractions to stdout
Errors: Logged to stderr
Exit:   0 on success, 1 on error

Requires:
    - langextract (pip install langextract)
    - GEMINI_API_KEY environment variable
"""

import sys
import json
import argparse
import os


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract dataset signals from manuscript text using langextract"
    )
    parser.add_argument(
        "--prompt",
        required=True,
        help="Path to the prompt description file (.txt)",
    )
    parser.add_argument(
        "--examples",
        required=True,
        help="Path to the few-shot examples file (.json)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("DATASETS_DETECTION_GEMINI_MODEL", "gemini-2.5-flash"),
        help="Model ID (default: gemini-2.5-flash or DATASETS_DETECTION_GEMINI_MODEL env var)",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=60,
        help="Parallel processing threads (default: 60)",
    )
    parser.add_argument(
        "--max-char-buffer",
        type=int,
        default=3000,
        help="Character context window per chunk (default: 3000)",
    )
    parser.add_argument(
        "--batch-length",
        type=int,
        default=60,
        help="Number of text batches for parallel processing (default: 60)",
    )
    parser.add_argument(
        "--extraction-passes",
        type=int,
        default=1,
        help="Number of sequential extraction passes (default: 1)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help=(
            "Sampling temperature (default: 0.0 = deterministic). langextract "
            "leaves this at the model default when unset, which made the same "
            "manuscript yield different signal sets run to run."
        ),
    )
    return parser.parse_args()


def load_prompt(path):
    """Load prompt description from a text file."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def load_examples(path):
    """Load few-shot examples from a JSON file and convert to langextract format."""
    import langextract as lx

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    examples = []
    for item in raw:
        extractions = []
        for ext in item.get("extractions", []):
            extractions.append(
                lx.data.Extraction(
                    ext["extraction_class"],
                    ext["extracted_text"],
                    attributes=ext.get("attributes", {}),
                )
            )
        examples.append(
            lx.data.ExampleData(
                text=item["text"],
                extractions=extractions,
            )
        )
    return examples


def main():
    args = parse_args()

    # Validate API key (per-service var, no fallback)
    api_key = os.environ.get("DATASETS_DETECTION_GEMINI_API_KEY")
    if not api_key:
        print("Error: DATASETS_DETECTION_GEMINI_API_KEY environment variable is required", file=sys.stderr)
        sys.exit(1)
    # Set GEMINI_API_KEY for langextract (it reads this env var internally)
    os.environ["GEMINI_API_KEY"] = api_key

    # Read markdown from stdin
    markdown_text = sys.stdin.read()
    if not markdown_text.strip():
        print("Error: No input text received via stdin", file=sys.stderr)
        sys.exit(1)

    print(
        f"Input text length: {len(markdown_text)} chars",
        file=sys.stderr,
    )

    # Load prompt and examples from files
    try:
        prompt = load_prompt(args.prompt)
        print(f"Loaded prompt: {len(prompt)} chars from {args.prompt}", file=sys.stderr)
    except FileNotFoundError:
        print(f"Error: Prompt file not found: {args.prompt}", file=sys.stderr)
        sys.exit(1)

    try:
        examples = load_examples(args.examples)
        print(
            f"Loaded {len(examples)} examples from {args.examples}",
            file=sys.stderr,
        )
    except FileNotFoundError:
        print(f"Error: Examples file not found: {args.examples}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in examples file: {e}", file=sys.stderr)
        sys.exit(1)

    # Run langextract
    import langextract as lx

    print(
        f"Starting extraction (model={args.model}, workers={args.max_workers}, "
        f"batch_length={args.batch_length}, buffer={args.max_char_buffer}, passes={args.extraction_passes})",
        file=sys.stderr,
    )

    try:
        result = lx.extract(
            text_or_documents=markdown_text,
            prompt_description=prompt,
            examples=examples,
            model_id=args.model,
            extraction_passes=args.extraction_passes,
            max_workers=args.max_workers,
            batch_length=args.batch_length,
            max_char_buffer=args.max_char_buffer,
            temperature=args.temperature,
        )
    except Exception as e:
        print(f"Error: langextract extraction failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Convert result to JSON-serializable format.
    #
    # The field is `extraction_text`. It was previously read as `extracted_text`
    # via getattr with a "" default, so every extraction carried an empty text
    # and nothing failed — the JS client masks it with `|| ''` and reads the
    # payload out of `attributes` instead. Same trap on the way in: the examples
    # JSON uses an `extracted_text` key, but it is passed POSITIONALLY to
    # lx.data.Extraction, so the mismatch never surfaced there either.
    #
    # `char_interval` is why LangExtract is in this pipeline at all: it is the
    # span the extraction was aligned to in the source text. Dropping it made a
    # grounded extraction indistinguishable from one the model invented — which
    # is how few-shot examples from the prompt reached the output as findings.
    extractions = []
    ungrounded = 0
    for doc in (result if isinstance(result, list) else [result]):
        for ext in getattr(doc, "extractions", []) or []:
            interval = getattr(ext, "char_interval", None)
            start = getattr(interval, "start_pos", None) if interval else None
            end = getattr(interval, "end_pos", None) if interval else None
            alignment = getattr(ext, "alignment_status", None)

            if start is None or end is None:
                # LangExtract could not align this to the source text. Keep it,
                # tagged, rather than dropping silently: the caller decides, and
                # a rising count here is the signal that a prompt change pushed
                # the model into inventing.
                ungrounded += 1

            extractions.append(
                {
                    "extraction_class": getattr(ext, "extraction_class", ""),
                    "extraction_text": getattr(ext, "extraction_text", "") or "",
                    "char_interval": (
                        None if start is None or end is None
                        else {"start_pos": start, "end_pos": end}
                    ),
                    "alignment_status": (
                        str(getattr(alignment, "value", alignment))
                        if alignment is not None else None
                    ),
                    "attributes": getattr(ext, "attributes", None) or {},
                }
            )

    print(
        f"Extraction complete: {len(extractions)} total extractions"
        f" ({ungrounded} not aligned to source text)",
        file=sys.stderr,
    )

    # Output JSON to stdout
    json.dump(extractions, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
