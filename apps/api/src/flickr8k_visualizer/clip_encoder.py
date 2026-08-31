from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image

from .download import download_verified_file
from .model_lock import ClipModelLock


class ModelFilesMissingError(RuntimeError):
    """The pinned model files are not available locally."""


def download_model_files(model_lock: ClipModelLock, model_dir: Path) -> None:
    """Download the pinned model files, skipping verified existing copies."""
    for model_file in model_lock.files:
        url = (
            f"https://huggingface.co/{model_lock.repo_id}/resolve/"
            f"{model_lock.revision}/{quote(model_file.path, safe='/')}?download=true"
        )
        download_verified_file(
            url,
            model_dir / model_file.path,
            expected_size=model_file.size_bytes,
            expected_hash=model_file.sha256,
        )


class ClipEncoder:
    """Image and text encoder for the pinned CLIP checkpoint.

    Loads only files already present in model_dir and returns L2-normalized
    float32 vectors, so cosine similarity is a plain dot product.
    """

    def __init__(self, model_dir: Path, model_lock: ClipModelLock) -> None:
        missing = [
            model_file.path
            for model_file in model_lock.files
            if not (model_dir / model_file.path).is_file()
        ]
        if missing:
            raise ModelFilesMissingError(
                f"Model files are missing from {model_dir}: {', '.join(missing)}"
            )

        # Imported lazily: torch and transformers are only needed once a real
        # encoder is constructed, never for the ordinary browsing API or tests.
        import torch
        from transformers import CLIPModel, CLIPProcessor

        self._torch = torch
        self._model = CLIPModel.from_pretrained(
            str(model_dir), use_safetensors=True, local_files_only=True
        )
        self._model.eval()
        self._processor = CLIPProcessor.from_pretrained(
            str(model_dir), local_files_only=True, use_fast=False
        )

    def encode_images(self, images: Sequence[Image.Image]) -> np.ndarray:
        inputs = self._processor(images=list(images), return_tensors="pt")
        with self._torch.no_grad():
            features = self._model.get_image_features(**inputs)
        return _l2_normalized(features.numpy())

    def encode_text(self, text: str) -> np.ndarray:
        inputs = self._processor(
            text=[text], padding=True, truncation=True, return_tensors="pt"
        )
        with self._torch.no_grad():
            features = self._model.get_text_features(**inputs)
        return _l2_normalized(features.numpy())[0]


def _l2_normalized(features: np.ndarray) -> np.ndarray:
    vectors = features.astype(np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, np.finfo(np.float32).eps)
