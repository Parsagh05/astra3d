#!/usr/bin/env python3
"""Runs the full panorama-quality matrix and reports pass/fail.

Each case renders a synthetic capture whose correct answer is known, stitches
it with the real worker, and checks the measured result against a budget.
Several cases are paired: a control run with a feature's input withheld and a
run with it supplied, so the check proves the feature earns its keep rather
than just asserting a number.

  python run_suite.py                 # full matrix
  python run_suite.py --quick         # skip the slow full-resolution case

Writes output/results.json, output/*.jpg, and RESULTS.md next to this file.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from harness import format_result, run_case

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SOURCE = REPO / "public" / "images" / "tours" / "flagship" / "arrival-2048.webp"
OUTPUT = HERE / "output"

# Stitch time must stay far below the 180s laptop processing timeout.
MAX_STITCH_SECONDS = 60.0

CASES = [
    {
        "label": "clean",
        "title": "Ideal capture",
        "why": "Baseline: every sweep starts on heading and tilts exactly +/-35 degrees.",
        "args": {},
        "max_rmse": 32.0,
        "slow": False,
    },
    {
        "label": "perturbed",
        "title": "Realistic sloppy capture",
        "why": "Sweeps start off-heading, tilts are wrong, and every frame has hand shake.",
        "args": {"perturb": True},
        "max_rmse": 34.0,
        "slow": False,
    },
    {
        "label": "perturbed-imu",
        "title": "Sloppy capture + motion data",
        "why": "Same capture with the phone's orientation samples available to the stitcher.",
        "args": {"perturb": True, "imu": True},
        "max_rmse": 34.0,
        "slow": False,
    },
    {
        "label": "roll-control",
        "title": "Tilted phone, no motion data",
        "why": "Control for roll correction: +/-8 degrees of roll with nothing to correct it.",
        "args": {"roll": 8.0},
        "max_rmse": 34.0,
        "slow": False,
    },
    {
        "label": "roll-imu",
        "title": "Tilted phone + motion data",
        "why": "Same roll, now correctable. Must beat roll-control.",
        "args": {"roll": 8.0, "imu": True},
        "max_rmse": 34.0,
        "better_than": "roll-control",
        "slow": False,
    },
    {
        "label": "hdr-control",
        "title": "Blown-out windows, single exposure",
        "why": "Control for bracketing: highlights clip to white with no companion still.",
        "args": {"perturb": True, "imu": True, "clip_highlights": True, "frame_width": 1200, "output_width": 3072},
        "max_rmse": None,
        "slow": False,
    },
    {
        "label": "hdr-fused",
        "title": "Blown-out windows + exposure bracket",
        "why": "Same scene with the dark companion still, Mertens-fused. Must beat hdr-control.",
        "args": {"perturb": True, "imu": True, "bracket": True, "frame_width": 1200, "output_width": 3072},
        "max_rmse": 50.0,
        "better_than": "hdr-control",
        "fewer_clipped_than": "hdr-control",
        "expect_fused": 24,
        "slow": False,
    },
    {
        "label": "full-resolution",
        "title": "Full-resolution photo capture",
        "why": "ImageCapture-grade stills at 1800px feeding the 4096-wide export.",
        "args": {"perturb": True, "imu": True, "frame_width": 1800, "output_width": 4096},
        "max_rmse": 34.0,
        "expect_source_width": 1800,
        "slow": True,
    },
    {
        "label": "bare-walls-control",
        "title": "Bare white walls, SIFT only",
        "why": "Control for learned matching: featureless walls starve SIFT, so the capture degrades or is rejected outright.",
        "args": {"bare_walls": True, "matcher": "sift"},
        "max_rmse": None,
        "expect_degraded": True,
        "needs_model": True,
        "slow": False,
    },
    {
        "label": "bare-walls-learned",
        "title": "Bare white walls + learned matcher",
        "why": "The same room with SuperPoint+LightGlue rescue. Must stitch cleanly where SIFT-only was rejected.",
        "args": {"bare_walls": True, "matcher": "auto"},
        "max_rmse": 30.0,
        "max_fallback": 2,
        "min_learned": 1,
        "needs_model": True,
        "slow": False,
    },
]

MATCHER_MODEL = REPO / "scripts" / "models" / "superpoint_lightglue_pipeline.onnx"


def check(case: dict, result: dict, results: dict[str, dict]) -> list[str]:
    """Returns the list of budget violations for one case."""
    failures = []
    if case.get("expect_degraded"):
        # A hostile control passes by being rejected or by leaning hard on
        # fallbacks; a clean stitch here would mean the scenario is too easy.
        if not result.get("rejected") and (result.get("fallbackPairs") or 0) < 4:
            failures.append("control stitched cleanly; the scenario no longer stresses SIFT")
        return failures
    if result.get("rejected"):
        return [f"capture rejected by the quality gate: {result.get('rejectionMessage')}"]

    if case["max_rmse"] is not None and result["rmse"] > case["max_rmse"]:
        failures.append(f"rmse {result['rmse']} exceeds budget {case['max_rmse']}")
    if result["stitchSeconds"] > MAX_STITCH_SECONDS:
        failures.append(f"stitch took {result['stitchSeconds']}s, over {MAX_STITCH_SECONDS}s budget")
    if result["matchedPairs"] != 24:
        failures.append(f"matched only {result['matchedPairs']} of 24 overlaps")
    if result["coverage"] is None or result["coverage"] < 0.99:
        failures.append(f"coverage {result['coverage']} below 0.99")

    baseline_label = case.get("better_than")
    if baseline_label:
        baseline = results.get(baseline_label)
        if baseline is None:
            failures.append(f"missing baseline {baseline_label}")
        elif result["rmse"] >= baseline["rmse"]:
            failures.append(
                f"rmse {result['rmse']} did not improve on {baseline_label} ({baseline['rmse']})"
            )
    clipped_baseline_label = case.get("fewer_clipped_than")
    if clipped_baseline_label:
        baseline = results.get(clipped_baseline_label)
        if baseline is None:
            failures.append(f"missing baseline {clipped_baseline_label}")
        elif result["clippedHighlights"] >= baseline["clippedHighlights"]:
            failures.append(
                f"clipped highlights {result['clippedHighlights']} did not improve on "
                f"{clipped_baseline_label} ({baseline['clippedHighlights']})"
            )
    if "expect_fused" in case and result["fusedFrames"] != case["expect_fused"]:
        failures.append(f"fused {result['fusedFrames']} frames, expected {case['expect_fused']}")
    if "expect_source_width" in case and result["sourceWidth"] != case["expect_source_width"]:
        failures.append(
            f"projected source width {result['sourceWidth']}, expected {case['expect_source_width']}"
        )
    if "max_fallback" in case and (result["fallbackPairs"] or 0) > case["max_fallback"]:
        failures.append(f"{result['fallbackPairs']} fallback pairs, budget {case['max_fallback']}")
    if "min_learned" in case and (result["learnedPairs"] or 0) < case["min_learned"]:
        failures.append(
            f"only {result['learnedPairs']} learned rescues, expected at least {case['min_learned']}"
        )
    return failures


def write_report(rows: list[tuple[dict, dict, list[str]]], passed: bool) -> None:
    lines = [
        "# Panorama quality results",
        "",
        "Generated by `python run_suite.py`. Every case renders a synthetic capture",
        "from a known panorama, stitches it with the real OpenCV worker, and compares",
        "the result against the image it was rendered from. Lower RMSE is better.",
        "",
        f"**Suite status: {'PASS' if passed else 'FAIL'}**",
        "",
        "| Case | RMSE | Ceiling zone | Clipped highlights | Matched | Fused | Stitch | Status |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for case, result, failures in rows:
        status = "pass" if not failures else "FAIL"
        if result.get("rejected"):
            lines.append(
                f"| {case['title']} | rejected by quality gate | - | - | - | - | "
                f"{result['stitchSeconds']}s | {status} |"
            )
            continue
        clipped = result["clippedHighlights"]
        lines.append(
            f"| {case['title']} | {result['rmse']} | {result['zones']['upper']} | "
            f"{f'{clipped:.1%}' if clipped is not None else '-'} | "
            f"{result['matchedPairs']}/24 | {result['fusedFrames'] or 0} | "
            f"{result['stitchSeconds']}s | {status} |"
        )

    lines += ["", "## What each case proves", ""]
    for case, result, failures in rows:
        lines.append(f"- **{case['title']}** (`{case['label']}`) — {case['why']}")
        if failures:
            for failure in failures:
                lines.append(f"  - FAIL: {failure}")
    lines += [
        "",
        "Panorama images for every case are written to `output/` so the results can be",
        "inspected visually, not only as numbers.",
        "",
    ]
    (HERE / "RESULTS.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true", help="skip slow full-resolution cases")
    args = parser.parse_args()

    if not SOURCE.exists():
        raise SystemExit(f"missing source panorama {SOURCE}")
    OUTPUT.mkdir(parents=True, exist_ok=True)

    results: dict[str, dict] = {}
    rows: list[tuple[dict, dict, list[str]]] = []
    passed = True

    matcher_installed = MATCHER_MODEL.exists()
    for case in CASES:
        if args.quick and case["slow"]:
            continue
        if case.get("needs_model") and not matcher_installed:
            print(
                f"[{case['label']}] SKIPPED: matcher model not installed "
                "(run npm run setup:panorama)"
            )
            continue
        result = run_case(str(SOURCE), label=case["label"], keep_dir=OUTPUT, **case["args"])
        results[case["label"]] = result
        failures = check(case, result, results)
        passed = passed and not failures
        rows.append((case, result, failures))
        status = "pass" if not failures else "FAIL " + "; ".join(failures)
        print(f"{format_result(result)}  -> {status}")

    (OUTPUT / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    write_report(rows, passed)
    print(f"\n{'PASS' if passed else 'FAIL'}: {len(rows)} cases. See RESULTS.md and output/.")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
