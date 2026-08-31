"""Real-model smoke test, excluded from the default suite.

Run after `npm run prepare:data` with:

    FLICKR8K_REAL_MODEL=1 npm run test:api -- apps/api/tests/test_visual_smoke.py
"""

import os

import numpy as np
import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(
    os.getenv("FLICKR8K_REAL_MODEL") != "1",
    reason="Set FLICKR8K_REAL_MODEL=1 to run the real-model smoke test",
)


def test_pinned_clip_model_encodes_and_ranks_locally() -> None:
    from flickr8k_visualizer.clip_encoder import ClipEncoder
    from flickr8k_visualizer.config import Settings
    from flickr8k_visualizer.model_lock import load_model_lock

    settings = Settings.from_env()
    model_lock = load_model_lock()
    encoder = ClipEncoder(settings.model_dir, model_lock)

    red = Image.new("RGB", (224, 224), (220, 30, 30))
    blue = Image.new("RGB", (224, 224), (30, 30, 220))
    image_vectors = encoder.encode_images([red, blue])
    text_vector = encoder.encode_text("a solid red image")

    assert image_vectors.shape == (2, model_lock.embedding_dimension)
    assert text_vector.shape == (model_lock.embedding_dimension,)
    assert np.linalg.norm(image_vectors, axis=1) == pytest.approx([1.0, 1.0])
    assert np.linalg.norm(text_vector) == pytest.approx(1.0)

    red_score, blue_score = image_vectors @ text_vector
    assert red_score > blue_score
