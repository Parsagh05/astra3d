"""Real-worker regression: a narrow, zoomed phone finishes with only 12 stills.

Run: python -m unittest discover -s tests/panorama-quality -p test_quick_capture.py
"""
import unittest
from pathlib import Path
from harness import run_case


class QuickCaptureTest(unittest.TestCase):
    def test_one_ring_with_measured_zoomed_lens(self):
        source = Path(__file__).resolve().parents[2] / "public/images/tours/flagship/arrival-2048.webp"
        result = run_case(source, label="quick-12", capture_extent="quick",
                          lens_fov=59.0, measure_lens=True, capture_zoom=1.4,
                          matcher="sift", frame_width=900, imu=True)
        self.assertFalse(result["rejected"], result)
        self.assertEqual(result["matchedPairs"], 12)
        self.assertEqual(result["fusedFrames"], 0)
        self.assertEqual(result["coverageScope"], "eye-level ring")
        self.assertGreaterEqual(result["coverage"], 0.99)
        self.assertLess(result["zones"]["middle"], 40)
        self.assertAlmostEqual(result["horizontalFov"], 59, delta=3)
        self.assertTrue(any("soft-filled" in warning for warning in result["warnings"]))
        print(result, flush=True)
