#!/usr/bin/env python3
"""Create transparent foreground PNG frames with MediaPipe Image Segmenter."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PERSON_CONFIDENCE_MASK_INDEX = 1
PERSON_ALPHA_THRESHOLD = 0.20
ALPHA_FEATHER_RADIUS = 1.25
DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parent / "models" / "selfie_segmenter.tflite"
)


class RunnerConfig:
    def __init__(
        self,
        frames_dir: Path,
        matted_frames_dir: Path,
        model_path: Path,
        fps: float,
    ) -> None:
        self.frames_dir = frames_dir
        self.matted_frames_dir = matted_frames_dir
        self.model_path = model_path
        self.fps = fps


def load_config(argv: list[str] | None = None) -> RunnerConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", required=True)
    parser.add_argument("--matted-frames-dir", required=True)
    parser.add_argument("--fps", type=float, default=30)
    args = parser.parse_args(argv)

    fps = args.fps
    if fps <= 0:
        raise RuntimeError("--fps must be greater than 0")

    return RunnerConfig(
        frames_dir=Path(args.frames_dir),
        matted_frames_dir=Path(args.matted_frames_dir),
        model_path=DEFAULT_MODEL_PATH,
        fps=fps,
    )


def list_image_frames(frames_dir: Path) -> list[Path]:
    if not frames_dir.is_dir():
        raise RuntimeError(f"frames directory does not exist: {frames_dir}")
    frames = sorted(
        path
        for path in frames_dir.iterdir()
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    if not frames:
        raise RuntimeError("no image frames found for MediaPipe segmentation")
    return frames


def timestamp_ms(frame_index: int, fps: float) -> int:
    return int(round((frame_index * 1000) / fps))


def write_rgba_foreground(image_rgb, confidence_mask, output_path: Path) -> None:
    from PIL import Image, ImageFilter
    import numpy as np

    alpha = np.clip(
        (confidence_mask - PERSON_ALPHA_THRESHOLD)
        / (1.0 - PERSON_ALPHA_THRESHOLD),
        0.0,
        1.0,
    )
    alpha_image = Image.fromarray((alpha * 255).astype("uint8"), mode="L")
    if ALPHA_FEATHER_RADIUS > 0:
        alpha_image = alpha_image.filter(
            ImageFilter.GaussianBlur(radius=ALPHA_FEATHER_RADIUS)
        )

    rgba = Image.fromarray(image_rgb, mode="RGB").convert("RGBA")
    rgba.putalpha(alpha_image)
    rgba.save(output_path)


def select_person_confidence_mask(masks):
    if len(masks) > PERSON_CONFIDENCE_MASK_INDEX:
        return masks[PERSON_CONFIDENCE_MASK_INDEX]
    if len(masks) == 1:
        return masks[0]
    raise RuntimeError("MediaPipe did not return a person confidence mask")


def run(config: RunnerConfig) -> None:
    if not config.model_path.is_file():
        raise RuntimeError(f"MediaPipe model file is missing: {config.model_path}")

    import mediapipe as mp
    import numpy as np
    from PIL import Image
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    frames = list_image_frames(config.frames_dir)
    config.matted_frames_dir.mkdir(parents=True, exist_ok=True)

    options = vision.ImageSegmenterOptions(
        base_options=python.BaseOptions(model_asset_path=str(config.model_path)),
        running_mode=vision.RunningMode.VIDEO,
        output_confidence_masks=True,
        output_category_mask=False,
    )

    with vision.ImageSegmenter.create_from_options(options) as segmenter:
        for index, frame_path in enumerate(frames):
            image_rgb = np.asarray(Image.open(frame_path).convert("RGB"))
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
            result = segmenter.segment_for_video(
                mp_image,
                timestamp_ms(index, config.fps),
            )
            masks = result.confidence_masks or []
            person_mask = select_person_confidence_mask(masks)
            write_rgba_foreground(
                image_rgb,
                person_mask.numpy_view(),
                config.matted_frames_dir / f"{frame_path.stem}.png",
            )


def main() -> int:
    try:
        run(load_config(sys.argv[1:]))
        return 0
    except Exception as error:
        print(f"mediapipe_green_screen failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
