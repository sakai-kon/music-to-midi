import math
import unittest

from app import clamp_bpm, safe_filename_stem, settings_from_sensitivity


class ConversionSettingsTests(unittest.TestCase):
    def test_sensitivity_bounds_map_to_valid_thresholds(self):
        low = settings_from_sensitivity(0)
        high = settings_from_sensitivity(100)

        self.assertEqual(low["onset_threshold"], 0.75)
        self.assertEqual(low["frame_threshold"], 0.5)
        self.assertEqual(low["minimum_note_length"], 180.0)
        self.assertEqual(high["onset_threshold"], 0.3)
        self.assertEqual(high["frame_threshold"], 0.25)
        self.assertEqual(high["minimum_note_length"], 80.0)

    def test_sensitivity_is_clamped(self):
        self.assertEqual(settings_from_sensitivity(-10), settings_from_sensitivity(0))
        self.assertEqual(settings_from_sensitivity(110), settings_from_sensitivity(100))

    def test_bpm_is_clamped_to_supported_range(self):
        self.assertEqual(clamp_bpm(20), 40.0)
        self.assertEqual(clamp_bpm(120), 120.0)
        self.assertEqual(clamp_bpm(300), 240.0)

    def test_non_finite_bpm_is_rejected(self):
        with self.assertRaises(ValueError):
            clamp_bpm(math.nan)
        with self.assertRaises(ValueError):
            clamp_bpm(math.inf)

    def test_filename_is_sanitized(self):
        self.assertEqual(safe_filename_stem("../../my test song.mp3"), "my_test_song")
        self.assertEqual(safe_filename_stem(None), "audio")


if __name__ == "__main__":
    unittest.main()
