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

    # Per-service var first, shared key second. The caller resolves this and
    # passes the answer in, so the fallback here matters only when the script
    # is run by hand -- but a script that dies on a key the operator did set,
    # under a different name, is the kind of failure that costs an afternoon.
    api_key = (
        os.environ.get("DATASETS_DETECTION_GEMINI_API_KEY")
        or os.environ.get("GEMINI_API_KEY")
    )
    if not api_key:
        print(
            "Error: no Gemini API key. Set DATASETS_DETECTION_GEMINI_API_KEY "
            "or GEMINI_API_KEY.",
            file=sys.stderr,
        )
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

    # ── Counting what this pass spends ──────────────────────────────────────
    #
    # langextract does not surface token usage anywhere: no module in the
    # package references usage_metadata, and lx.extract() returns annotated
    # documents with nothing about what they cost. So the extraction pass was
    # invisible in a figure that claims to say what a run spent.
    #
    # The hook is the Google SDK's own Models.generate_content, not anything
    # inside langextract. Both would work; this one is a documented public API
    # that langextract must call, so it survives langextract's internals moving
    # and breaks loudly rather than silently if the SDK ever changes.
    #
    # Best effort, always: if any part of this fails the extraction still runs
    # and simply reports no usage. An accounting figure must never be the reason
    # a document fails to process.
    usage_totals = {
        "promptTokenCount": 0,
        "candidatesTokenCount": 0,
        "thoughtsTokenCount": 0,
        "cachedContentTokenCount": 0,
        "totalTokenCount": 0,
        "calls": 0,
    }
    usage_ok = False
    try:
        from google.genai.models import Models

        _original_generate = Models.generate_content

        def _counting_generate(self, *a, **kw):
            response = _original_generate(self, *a, **kw)
            try:
                meta = getattr(response, "usage_metadata", None)
                if meta is not None:
                    for key in (
                        "prompt_token_count",
                        "candidates_token_count",
                        "thoughts_token_count",
                        "cached_content_token_count",
                        "total_token_count",
                    ):
                        camel = {
                            "prompt_token_count": "promptTokenCount",
                            "candidates_token_count": "candidatesTokenCount",
                            "thoughts_token_count": "thoughtsTokenCount",
                            "cached_content_token_count": "cachedContentTokenCount",
                            "total_token_count": "totalTokenCount",
                        }[key]
                        usage_totals[camel] += int(getattr(meta, key, 0) or 0)
                    usage_totals["calls"] += 1
            except Exception:  # noqa: BLE001 - never let counting break extraction
                pass
            return response

        Models.generate_content = _counting_generate
        usage_ok = True
    except Exception as e:  # noqa: BLE001
        print(f"Token usage capture unavailable: {e}", file=sys.stderr)

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

    # Put the SDK back the way we found it, so a long-lived process is not left
    # with our wrapper in place.
    if usage_ok:
        try:
            from google.genai.models import Models as _M
            _M.generate_content = _original_generate
        except Exception:  # noqa: BLE001
            pass

    # Output JSON to stdout.
    #
    # An object rather than the bare array this used to print: the caller needs
    # what the pass cost as well as what it found, and `usage: null` is how it
    # learns the difference between "no model was called" and "we could not
    # count". The Node client is the only reader and changes with it.
    usage = usage_totals if (usage_ok and usage_totals["calls"] > 0) else None
    json.dump(
        {"extractions": extractions, "usage": usage, "model": args.model},
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
