#!/usr/bin/env python3
"""Checks for photo scans: unpacking photos.zip before the 3D pipeline runs.

    python scripts/test_photo_scan.py

Needs numpy and OpenCV only (pycolmap is not imported by these tests).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from splat_pipeline import MIN_PHOTOS, ScanError, extract_photos, same_size_images  # noqa: E402


def textured_photo(seed: int, size: tuple[int, int] = (480, 640)) -> np.ndarray:
    """A detailed image (random blocks) that scores as sharp."""
    rng = np.random.default_rng(seed)
    small = rng.integers(0, 255, (size[0] // 8, size[1] // 8, 3), dtype=np.uint8)
    return cv2.resize(small, (size[1], size[0]), interpolation=cv2.INTER_NEAREST)


def jpeg(image: np.ndarray) -> bytes:
    ok, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    assert ok
    return data.tobytes()


def write_zip(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as bundle:
        for name, data in entries.items():
            bundle.writestr(name, data)


class ExtractPhotosTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / "photos.zip"
        self.images = self.root / "work" / "images"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def extract(self, max_frames: int = 180) -> list[str]:
        return extract_photos(self.archive, self.images, max_frames, lambda _f, _m: None)

    def test_unpacks_photos_in_name_order_and_resizes_large_ones(self) -> None:
        entries = {f"photo_{index:04d}.jpg": jpeg(textured_photo(index)) for index in range(1, MIN_PHOTOS + 3)}
        entries["photo_0005.jpg"] = jpeg(textured_photo(5, (2400, 3200)))
        # Entries that are not photos are ignored.
        entries["notes.txt"] = b"hello"
        entries["__MACOSX/._photo_0001.jpg"] = b"junk"
        write_zip(self.archive, entries)
        names = self.extract()
        self.assertEqual(names, [f"frame_{index:05d}.jpg" for index in range(MIN_PHOTOS + 2)])
        self.assertEqual(sorted(path.name for path in self.images.iterdir()), names)
        large = cv2.imread(str(self.images / "frame_00004.jpg"))
        self.assertEqual(max(large.shape[:2]), 1600)

    def test_drops_blurred_photos_while_enough_remain(self) -> None:
        entries = {f"photo_{index:04d}.jpg": jpeg(textured_photo(index)) for index in range(MIN_PHOTOS + 2)}
        entries["photo_0003.jpg"] = jpeg(cv2.GaussianBlur(textured_photo(3), (0, 0), 12))
        write_zip(self.archive, entries)
        self.assertEqual(len(self.extract()), MIN_PHOTOS + 1)

    def test_thins_to_max_frames_evenly(self) -> None:
        write_zip(self.archive, {f"photo_{index:04d}.jpg": jpeg(textured_photo(index)) for index in range(40)})
        self.assertEqual(len(self.extract(max_frames=25)), 25)

    def test_never_writes_outside_the_images_folder(self) -> None:
        entries = {f"../../escape_{index:02d}.jpg": jpeg(textured_photo(index)) for index in range(MIN_PHOTOS)}
        write_zip(self.archive, entries)
        names = self.extract()
        self.assertEqual(len(names), MIN_PHOTOS)
        self.assertEqual(list(self.root.glob("escape_*")), [])
        self.assertEqual(list(self.root.parent.glob("escape_*")), [])

    def test_explains_too_few_or_unreadable_photos(self) -> None:
        write_zip(self.archive, {f"photo_{index}.jpg": jpeg(textured_photo(index)) for index in range(5)})
        with self.assertRaisesRegex(ScanError, "at least 20"):
            self.extract()
        write_zip(self.archive, {f"photo_{index:02d}.jpg": b"not a jpeg" for index in range(MIN_PHOTOS)})
        with self.assertRaisesRegex(ScanError, "could be opened"):
            self.extract()
        self.archive.write_bytes(b"not a zip at all")
        with self.assertRaisesRegex(ScanError, "could not be read"):
            self.extract()

    def test_same_size_images_detects_mixed_orientation(self) -> None:
        self.images.mkdir(parents=True)
        for index in range(3):
            cv2.imwrite(str(self.images / f"frame_{index:05d}.jpg"), textured_photo(index))
        self.assertTrue(same_size_images(self.images))
        cv2.imwrite(str(self.images / "frame_00003.jpg"), textured_photo(3, (640, 480)))
        self.assertFalse(same_size_images(self.images))


if __name__ == "__main__":
    unittest.main()
