import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("mediapipe_green_screen.py")
SPEC = importlib.util.spec_from_file_location("mediapipe_green_screen", SCRIPT_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class MediaPipeGreenScreenRunnerTest(unittest.TestCase):
    def test_list_png_frames_returns_sorted_pngs_only(self):
        with tempfile.TemporaryDirectory() as directory:
            frames_dir = Path(directory)
            (frames_dir / "000002.png").write_bytes(b"")
            (frames_dir / "notes.txt").write_text("skip")
            (frames_dir / "000001.PNG").write_bytes(b"")

            self.assertEqual(
                [path.name for path in runner.list_image_frames(frames_dir)],
                ["000001.PNG", "000002.png"],
            )

    def test_write_rgba_foreground_cuts_out_the_person(self):
        # Exercises the Pillow path the worker runs on every frame, so a
        # Pillow upgrade that changes Image.fromarray shows up here.
        import numpy as np
        from PIL import Image

        image_rgb = np.zeros((4, 6, 3), dtype=np.uint8)
        image_rgb[..., 0] = 200
        confidence_mask = np.zeros((4, 6), dtype=np.float32)
        confidence_mask[:, 3:] = 1.0

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "frame.png"
            runner.write_rgba_foreground(image_rgb, confidence_mask, output_path)

            with Image.open(output_path) as written:
                self.assertEqual(written.mode, "RGBA")
                self.assertEqual(written.size, (6, 4))
                self.assertEqual(written.getpixel((0, 0))[:3], (200, 0, 0))
                self.assertLess(written.getpixel((0, 0))[3], 16)
                self.assertGreater(written.getpixel((5, 0))[3], 240)

    def test_timestamp_ms_uses_frame_index_and_fps(self):
        self.assertEqual(runner.timestamp_ms(0, 30), 0)
        self.assertEqual(runner.timestamp_ms(15, 30), 500)

    def test_load_config_uses_fixed_model_path(self):
        with tempfile.TemporaryDirectory() as frames_dir:
            with tempfile.TemporaryDirectory() as matted_dir:
                config = runner.load_config(
                    [
                        "--frames-dir",
                        frames_dir,
                        "--matted-frames-dir",
                        matted_dir,
                        "--fps",
                        "24",
                    ]
                )

                self.assertEqual(config.frames_dir, Path(frames_dir))
                self.assertEqual(config.matted_frames_dir, Path(matted_dir))
                self.assertEqual(config.model_path, runner.DEFAULT_MODEL_PATH)
                self.assertEqual(config.fps, 24)


if __name__ == "__main__":
    unittest.main()
