from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path, PurePosixPath

MODEL_LOCK_FILENAME = "clip.lock.json"
MODEL_LOCK_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class ModelFile:
    path: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class ClipModelLock:
    repo_id: str
    revision: str
    embedding_dimension: int
    preprocessing_version: int
    files: tuple[ModelFile, ...]


def load_model_lock(path: Path | None = None) -> ClipModelLock:
    source = path or files("flickr8k_visualizer").joinpath(MODEL_LOCK_FILENAME)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read model lock file: {source}") from error

    if not isinstance(value, Mapping):
        raise RuntimeError(f"Model lock must contain a JSON object: {source}")
    if value.get("schema_version") != MODEL_LOCK_SCHEMA_VERSION:
        raise RuntimeError(
            f"Unsupported model lock schema in {source}; "
            f"expected {MODEL_LOCK_SCHEMA_VERSION}"
        )

    repo_id = value.get("repo_id")
    if not isinstance(repo_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id
    ):
        raise RuntimeError(f"Invalid model repository ID in {source}")

    revision = value.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError(
            f"Model revision in {source} must be a full 40-character commit SHA"
        )

    embedding_dimension = value.get("embedding_dimension")
    if not _is_positive_integer(embedding_dimension):
        raise RuntimeError(f"Invalid embedding dimension in {source}")

    preprocessing_version = value.get("preprocessing_version")
    if not _is_positive_integer(preprocessing_version):
        raise RuntimeError(f"Invalid preprocessing version in {source}")

    file_values = value.get("files")
    if not isinstance(file_values, list) or not file_values:
        raise RuntimeError(f"Model lock must contain at least one file: {source}")

    model_files: list[ModelFile] = []
    seen_paths: set[str] = set()
    for index, file_value in enumerate(file_values):
        if not isinstance(file_value, Mapping):
            raise RuntimeError(f"Invalid file {index} in {source}")

        file_path = file_value.get("path")
        size_bytes = file_value.get("size_bytes")
        sha256 = file_value.get("sha256")

        if not isinstance(file_path, str) or not _is_safe_file_name(file_path):
            raise RuntimeError(f"Invalid path for file {index} in {source}")
        if file_path in seen_paths:
            raise RuntimeError(f"Duplicate file path in {source}: {file_path}")
        if not _is_positive_integer(size_bytes):
            raise RuntimeError(f"Invalid size for file {index} in {source}")
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise RuntimeError(f"Invalid SHA-256 for file {index} in {source}")

        seen_paths.add(file_path)
        model_files.append(
            ModelFile(path=file_path, size_bytes=size_bytes, sha256=sha256)
        )

    return ClipModelLock(
        repo_id=repo_id,
        revision=revision,
        embedding_dimension=embedding_dimension,
        preprocessing_version=preprocessing_version,
        files=tuple(model_files),
    )


def _is_safe_file_name(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        not path.is_absolute()
        and len(path.parts) == 1
        and path.name == value
        and value not in {".", ".."}
    )


def _is_positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
