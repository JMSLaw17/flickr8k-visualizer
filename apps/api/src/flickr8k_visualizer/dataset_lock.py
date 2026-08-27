from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path, PurePosixPath

LOCK_FILENAME = "flickr8k.lock.json"
LOCK_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class DatasetShard:
    split: str
    repo_path: str
    size_bytes: int
    sha256: str
    row_count: int

    @property
    def filename(self) -> str:
        return PurePosixPath(self.repo_path).name


@dataclass(frozen=True, slots=True)
class DatasetLock:
    repo_id: str
    revision: str
    shards: tuple[DatasetShard, ...]


def load_dataset_lock(path: Path | None = None) -> DatasetLock:
    source = path or files("flickr8k_visualizer").joinpath(LOCK_FILENAME)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read dataset lock file: {source}") from error

    if not isinstance(value, Mapping):
        raise RuntimeError(f"Dataset lock must contain a JSON object: {source}")
    if value.get("schema_version") != LOCK_SCHEMA_VERSION:
        raise RuntimeError(
            f"Unsupported dataset lock schema in {source}; "
            f"expected {LOCK_SCHEMA_VERSION}"
        )

    repo_id = value.get("repo_id")
    if not isinstance(repo_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id
    ):
        raise RuntimeError(f"Invalid dataset repository ID in {source}")

    revision = value.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError(
            f"Dataset revision in {source} must be a full 40-character commit SHA"
        )

    shard_values = value.get("shards")
    if not isinstance(shard_values, list) or not shard_values:
        raise RuntimeError(f"Dataset lock must contain at least one shard: {source}")

    shards: list[DatasetShard] = []
    seen_paths: set[str] = set()
    for index, shard_value in enumerate(shard_values):
        if not isinstance(shard_value, Mapping):
            raise RuntimeError(f"Invalid shard {index} in {source}")

        split = shard_value.get("split")
        repo_path = shard_value.get("path")
        size_bytes = shard_value.get("size_bytes")
        sha256 = shard_value.get("sha256")
        row_count = shard_value.get("row_count")

        if not isinstance(split, str) or not split:
            raise RuntimeError(f"Invalid split for shard {index} in {source}")
        if not isinstance(repo_path, str) or not _is_safe_repo_path(repo_path):
            raise RuntimeError(f"Invalid path for shard {index} in {source}")
        if repo_path in seen_paths:
            raise RuntimeError(f"Duplicate shard path in {source}: {repo_path}")
        if not _is_positive_integer(size_bytes):
            raise RuntimeError(f"Invalid size for shard {index} in {source}")
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise RuntimeError(f"Invalid SHA-256 for shard {index} in {source}")
        if not _is_positive_integer(row_count):
            raise RuntimeError(f"Invalid row count for shard {index} in {source}")

        seen_paths.add(repo_path)
        shards.append(
            DatasetShard(
                split=split,
                repo_path=repo_path,
                size_bytes=size_bytes,
                sha256=sha256,
                row_count=row_count,
            )
        )

    return DatasetLock(repo_id=repo_id, revision=revision, shards=tuple(shards))


def manifest_matches_lock(
    manifest: Mapping[str, object], dataset_lock: DatasetLock
) -> bool:
    dataset = manifest.get("dataset")
    if not isinstance(dataset, Mapping) or dataset != {
        "repo_id": dataset_lock.repo_id,
        "revision": dataset_lock.revision,
    }:
        return False

    shard_values = manifest.get("shards")
    if not isinstance(shard_values, list):
        return False

    actual_shards: dict[str, tuple[object, object, object, object]] = {}
    for shard_value in shard_values:
        if not isinstance(shard_value, Mapping):
            return False
        repo_path = shard_value.get("path")
        if not isinstance(repo_path, str) or repo_path in actual_shards:
            return False
        actual_shards[repo_path] = (
            shard_value.get("split"),
            shard_value.get("size_bytes"),
            shard_value.get("sha256"),
            shard_value.get("row_count"),
        )

    expected_shards = {
        shard.repo_path: (
            shard.split,
            shard.size_bytes,
            shard.sha256,
            shard.row_count,
        )
        for shard in dataset_lock.shards
    }
    return actual_shards == expected_shards


def ready_marker_matches_lock(path: Path, dataset_lock: DatasetLock) -> bool:
    try:
        return path.read_text(encoding="utf-8") == f"{dataset_lock.revision}\n"
    except OSError:
        return False


def prepared_identity_matches_lock(manifest_path: Path, ready_path: Path) -> bool:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        dataset_lock = load_dataset_lock()
    except (OSError, json.JSONDecodeError, RuntimeError):
        return False

    return (
        isinstance(manifest, Mapping)
        and manifest_matches_lock(manifest, dataset_lock)
        and ready_marker_matches_lock(ready_path, dataset_lock)
    )


def _is_safe_repo_path(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        not path.is_absolute()
        and ".." not in path.parts
        and path.as_posix() == value
        and path.suffix == ".parquet"
    )


def _is_positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
