from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .lock_common import (
    is_positive_integer,
    is_sha256,
    read_lock_object,
    require_entries,
    require_repo_id,
    require_revision,
)

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
    value, source = read_lock_object(
        path,
        filename=MODEL_LOCK_FILENAME,
        schema_version=MODEL_LOCK_SCHEMA_VERSION,
        kind="model",
    )
    repo_id = require_repo_id(value, source, "model")
    revision = require_revision(value, source, "model")

    embedding_dimension = value.get("embedding_dimension")
    if not is_positive_integer(embedding_dimension):
        raise RuntimeError(f"Invalid embedding dimension in {source}")

    preprocessing_version = value.get("preprocessing_version")
    if not is_positive_integer(preprocessing_version):
        raise RuntimeError(f"Invalid preprocessing version in {source}")

    model_files: list[ModelFile] = []
    seen_paths: set[str] = set()
    for index, file_value in enumerate(
        require_entries(value, "files", source, "model", "file")
    ):
        if not isinstance(file_value, Mapping):
            raise RuntimeError(f"Invalid file {index} in {source}")

        file_path = file_value.get("path")
        size_bytes = file_value.get("size_bytes")
        sha256 = file_value.get("sha256")

        if not isinstance(file_path, str) or not _is_safe_file_name(file_path):
            raise RuntimeError(f"Invalid path for file {index} in {source}")
        if file_path in seen_paths:
            raise RuntimeError(f"Duplicate file path in {source}: {file_path}")
        if not is_positive_integer(size_bytes):
            raise RuntimeError(f"Invalid size for file {index} in {source}")
        if not is_sha256(sha256):
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
