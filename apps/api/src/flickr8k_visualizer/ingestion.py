from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
from collections import Counter
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

import pyarrow.parquet as parquet
from PIL import Image, ImageOps

from .config import Settings
from .dataset_lock import (
    DatasetLock,
    DatasetShard,
    load_dataset_lock,
    manifest_matches_lock,
    ready_marker_matches_lock,
)
from .db import connect_database, initialize_database, materialize_duplicate_groups

LOGGER = logging.getLogger(__name__)

CAPTION_COLUMN = re.compile(r"^caption_(\d+)$")
THUMBNAIL_SIZE = (480, 480)
DOWNLOAD_TIMEOUT_SECONDS = 60


@dataclass(frozen=True, slots=True)
class ImagePayload:
    data: bytes
    source_id: str | None


@dataclass(frozen=True, slots=True)
class ImageMetadata:
    width: int
    height: int
    extension: str
    mime_type: str


def image_content_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def parse_image_cell(value: object) -> ImagePayload:
    if not isinstance(value, Mapping):
        raise ValueError("Image metadata must be a mapping")

    raw_bytes = value.get("bytes")
    if not isinstance(raw_bytes, (bytes, bytearray, memoryview)):
        raise ValueError("Image metadata does not contain embedded bytes")

    raw_path = value.get("path")
    source_id = _validate_source_id(raw_path) if isinstance(raw_path, str) else None
    return ImagePayload(data=bytes(raw_bytes), source_id=source_id)


def parse_captions(record: Mapping[str, object]) -> list[str]:
    indexed_captions: list[tuple[int, str]] = []
    for key, value in record.items():
        match = CAPTION_COLUMN.fullmatch(key)
        if match is None or not isinstance(value, str):
            continue
        if value.strip():
            indexed_captions.append((int(match.group(1)), value))

    indexed_captions.sort(key=lambda item: item[0])
    return [caption for _, caption in indexed_captions]


def stable_sample_id(source_id: str | None, content_hash: str) -> str:
    if source_id:
        source_path = PurePosixPath(source_id)
        if len(source_path.parts) == 1 and re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]*", source_path.stem
        ):
            return source_path.stem

        digest = hashlib.sha256(source_id.encode("utf-8")).hexdigest()
        return f"source-{digest[:24]}"

    return f"sha256-{content_hash}"


def read_image_metadata(image_bytes: bytes) -> ImageMetadata:
    with Image.open(BytesIO(image_bytes)) as image:
        image.load()
        image_format = image.format
        width, height = ImageOps.exif_transpose(image).size

    if not image_format:
        raise ValueError("Image format could not be detected")

    normalized_format = image_format.upper()
    extension = {
        "GIF": "gif",
        "JPEG": "jpg",
        "PNG": "png",
        "WEBP": "webp",
    }.get(normalized_format, normalized_format.lower())
    mime_type = Image.MIME.get(normalized_format, f"image/{extension}")
    return ImageMetadata(
        width=width,
        height=height,
        extension=extension,
        mime_type=mime_type,
    )


def prepare_dataset(data_dir: Path, *, force: bool = False) -> dict[str, Any]:
    dataset_lock = load_dataset_lock()
    data_dir = data_dir.expanduser().resolve()
    manifest_path = data_dir / "manifest.json"
    database_path = data_dir / "flickr8k.sqlite3"
    ready_path = data_dir / ".ready"
    downloads_dir = data_dir / "downloads"

    try:
        existing_manifest = _read_manifest(manifest_path)
    except RuntimeError:
        if not force:
            raise
        existing_manifest = None
    if existing_manifest and not force:
        if not manifest_matches_lock(existing_manifest, dataset_lock):
            raise RuntimeError(
                "The prepared dataset does not match datasets/flickr8k.lock.json. "
                "Use --force to replace it."
            )
        if ready_path.is_file() and not ready_marker_matches_lock(
            ready_path, dataset_lock
        ):
            raise RuntimeError(
                "The prepared dataset ready marker does not match "
                "datasets/flickr8k.lock.json. Use --force to replace it."
            )
        if (
            database_path.is_file()
            and (data_dir / "images").is_dir()
            and (data_dir / "thumbnails").is_dir()
            and ready_marker_matches_lock(ready_path, dataset_lock)
        ):
            _remove_downloaded_parquet(downloads_dir, dataset_lock.shards)
            LOGGER.info(
                "Flickr8k revision %s is already prepared", dataset_lock.revision
            )
            return existing_manifest

    downloads_dir.mkdir(parents=True, exist_ok=True)
    shard_paths = {
        shard: _download_shard(shard, downloads_dir, dataset_lock)
        for shard in dataset_lock.shards
    }
    return ingest_downloaded_shards(
        data_dir,
        shard_paths,
        repo_id=dataset_lock.repo_id,
        revision=dataset_lock.revision,
        delete_parquet=True,
    )


def ingest_downloaded_shards(
    data_dir: Path,
    shard_paths: Mapping[DatasetShard, Path],
    *,
    repo_id: str,
    revision: str,
    delete_parquet: bool,
) -> dict[str, Any]:
    data_dir = data_dir.expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    images_dir = data_dir / "images"
    thumbnails_dir = data_dir / "thumbnails"
    images_dir.mkdir(parents=True, exist_ok=True)
    thumbnails_dir.mkdir(parents=True, exist_ok=True)

    for shard, shard_path in shard_paths.items():
        _verify_file(shard_path, shard.size_bytes, shard.sha256)

    database_path = data_dir / "flickr8k.sqlite3"
    manifest_path = data_dir / "manifest.json"
    ready_path = data_dir / ".ready"
    temporary_database_path = data_dir / ".flickr8k.sqlite3.ingesting"
    temporary_manifest_path = data_dir / ".manifest.json.ingesting"
    temporary_database_path.unlink(missing_ok=True)
    temporary_manifest_path.unlink(missing_ok=True)
    initialize_database(temporary_database_path)

    split_counts: Counter[str] = Counter()
    hash_counts: Counter[str] = Counter()
    shard_row_counts: dict[str, int] = {}
    duplicate_group_count = 0

    try:
        connection = connect_database(temporary_database_path)
        try:
            with connection:
                for shard, shard_path in shard_paths.items():
                    row_count = _ingest_shard(
                        connection,
                        shard,
                        shard_path,
                        data_dir,
                        images_dir,
                        thumbnails_dir,
                        split_counts,
                        hash_counts,
                    )
                    if row_count != shard.row_count:
                        raise ValueError(
                            f"{shard.filename} contains {row_count} rows; "
                            f"expected {shard.row_count}"
                        )
                    shard_row_counts[shard.repo_path] = row_count

                duplicate_group_count = materialize_duplicate_groups(connection)

            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        finally:
            connection.close()

        sample_count = sum(split_counts.values())
        expected_count = sum(shard.row_count for shard in shard_paths)
        if sample_count != expected_count:
            raise ValueError(
                f"Ingested {sample_count} samples; expected {expected_count}"
            )

        manifest = _build_manifest(
            repo_id=repo_id,
            revision=revision,
            shard_paths=shard_paths,
            shard_row_counts=shard_row_counts,
            split_counts=split_counts,
            hash_counts=hash_counts,
            duplicate_group_count=duplicate_group_count,
        )
        _write_manifest(temporary_manifest_path, manifest)
        ready_path.unlink(missing_ok=True)
        os.replace(temporary_database_path, database_path)
        os.replace(temporary_manifest_path, manifest_path)
        _write_ready_marker(ready_path, revision)

        if delete_parquet:
            for shard_path in shard_paths.values():
                shard_path.unlink(missing_ok=True)
            _remove_empty_directory(next(iter(shard_paths.values())).parent)

        return manifest
    except Exception:
        temporary_database_path.unlink(missing_ok=True)
        temporary_manifest_path.unlink(missing_ok=True)
        raise


def _ingest_shard(
    connection: sqlite3.Connection,
    shard: DatasetShard,
    shard_path: Path,
    data_dir: Path,
    images_dir: Path,
    thumbnails_dir: Path,
    split_counts: Counter[str],
    hash_counts: Counter[str],
) -> int:
    parquet_file = parquet.ParquetFile(shard_path)
    required_columns = {"image", *(f"caption_{index}" for index in range(5))}
    available_columns = set(parquet_file.schema_arrow.names)
    missing_columns = required_columns - available_columns
    if missing_columns:
        raise ValueError(
            f"{shard.filename} is missing columns: {sorted(missing_columns)}"
        )

    row_count = 0
    columns = ["image", *(f"caption_{index}" for index in range(5))]
    for batch in parquet_file.iter_batches(batch_size=64, columns=columns):
        for record in batch.to_pylist():
            _ingest_record(
                connection,
                record,
                shard.split,
                data_dir,
                images_dir,
                thumbnails_dir,
                hash_counts,
            )
            row_count += 1

    split_counts[shard.split] += row_count
    LOGGER.info("Ingested %s rows from %s", row_count, shard.filename)
    return row_count


def _ingest_record(
    connection: sqlite3.Connection,
    record: Mapping[str, object],
    split: str,
    data_dir: Path,
    images_dir: Path,
    thumbnails_dir: Path,
    hash_counts: Counter[str],
) -> None:
    image = parse_image_cell(record.get("image"))
    captions = parse_captions(record)
    if not captions:
        raise ValueError("Sample does not contain a caption")

    content_hash = image_content_hash(image.data)
    sample_id = stable_sample_id(image.source_id, content_hash)
    metadata = read_image_metadata(image.data)

    original_path = (
        images_dir / content_hash[:2] / (f"{content_hash}.{metadata.extension}")
    )
    thumbnail_path = thumbnails_dir / content_hash[:2] / f"{content_hash}.webp"
    _write_original_image(original_path, image.data, content_hash)
    _write_thumbnail(thumbnail_path, image.data)

    source_id = image.source_id or f"sha256:{content_hash}"
    try:
        connection.execute(
            """
            INSERT INTO samples (
                id, source_id, split, content_sha256, width, height,
                mime_type, file_size_bytes, original_path, thumbnail_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sample_id,
                source_id,
                split,
                content_hash,
                metadata.width,
                metadata.height,
                metadata.mime_type,
                len(image.data),
                original_path.relative_to(data_dir).as_posix(),
                thumbnail_path.relative_to(data_dir).as_posix(),
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ValueError(f"Duplicate stable sample ID: {sample_id}") from error

    connection.executemany(
        "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
        ((sample_id, position, caption) for position, caption in enumerate(captions)),
    )
    hash_counts[content_hash] += 1


def _write_original_image(path: Path, data: bytes, expected_hash: str) -> None:
    if path.is_file():
        if image_content_hash(path.read_bytes()) != expected_hash:
            raise ValueError(f"Existing image has unexpected content: {path}")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary_path.write_bytes(data)
    os.replace(temporary_path, path)


def _write_thumbnail(path: Path, image_bytes: bytes) -> None:
    if path.is_file():
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with Image.open(BytesIO(image_bytes)) as image:
        thumbnail = ImageOps.exif_transpose(image).convert("RGB")
        thumbnail.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
        thumbnail.save(temporary_path, format="WEBP", quality=82, method=6)
    os.replace(temporary_path, path)


def _download_shard(
    shard: DatasetShard, downloads_dir: Path, dataset_lock: DatasetLock
) -> Path:
    destination = downloads_dir / shard.filename
    if destination.is_file():
        try:
            _verify_file(destination, shard.size_bytes, shard.sha256)
            LOGGER.info("Using verified download %s", destination.name)
            return destination
        except ValueError:
            destination.unlink()

    partial_path = destination.with_suffix(f"{destination.suffix}.partial")
    partial_path.unlink(missing_ok=True)
    url = (
        f"https://huggingface.co/datasets/{dataset_lock.repo_id}/resolve/"
        f"{dataset_lock.revision}/{quote(shard.repo_path, safe='/')}?download=true"
    )
    LOGGER.info("Downloading %s (%.1f MB)", shard.filename, shard.size_bytes / 1e6)
    request = Request(url, headers={"User-Agent": "flickr8k-visualizer/0.1"})
    try:
        with (
            urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response,
            partial_path.open("wb") as output,
        ):
            while chunk := response.read(4 * 1024 * 1024):
                output.write(chunk)
        _verify_file(partial_path, shard.size_bytes, shard.sha256)
        os.replace(partial_path, destination)
    except Exception:
        partial_path.unlink(missing_ok=True)
        raise
    return destination


def _verify_file(path: Path, expected_size: int, expected_hash: str) -> None:
    if not path.is_file():
        raise ValueError(f"Dataset shard does not exist: {path}")
    if path.stat().st_size != expected_size:
        raise ValueError(
            f"Unexpected size for {path.name}: {path.stat().st_size}; "
            f"expected {expected_size}"
        )

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError(f"Checksum verification failed for {path.name}")


def _build_manifest(
    *,
    repo_id: str,
    revision: str,
    shard_paths: Mapping[DatasetShard, Path],
    shard_row_counts: Mapping[str, int],
    split_counts: Counter[str],
    hash_counts: Counter[str],
    duplicate_group_count: int,
) -> dict[str, Any]:
    sample_count = sum(split_counts.values())
    duplicate_sample_count = sum(count - 1 for count in hash_counts.values())
    return {
        "schema_version": 1,
        "dataset": {"repo_id": repo_id, "revision": revision},
        "prepared_at": datetime.now(UTC).isoformat(),
        "sample_count": sample_count,
        "split_counts": dict(sorted(split_counts.items())),
        "unique_image_count": len(hash_counts),
        "duplicate_group_count": duplicate_group_count,
        "duplicate_sample_count": duplicate_sample_count,
        "database": "flickr8k.sqlite3",
        "images_directory": "images",
        "thumbnails_directory": "thumbnails",
        "shards": [
            {
                "path": shard.repo_path,
                "split": shard.split,
                "size_bytes": shard.size_bytes,
                "sha256": shard.sha256,
                "row_count": shard_row_counts[shard.repo_path],
            }
            for shard in shard_paths
        ],
    }


def _write_manifest(path: Path, manifest: Mapping[str, object]) -> None:
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary_path, path)


def _write_ready_marker(path: Path, revision: str) -> None:
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary_path.write_text(f"{revision}\n", encoding="utf-8")
    os.replace(temporary_path, path)


def _read_manifest(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Could not read {path}. Use --force to replace the prepared data."
        ) from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Invalid dataset manifest: {path}")
    return value


def _remove_downloaded_parquet(
    downloads_dir: Path, shards: Sequence[DatasetShard]
) -> None:
    for shard in shards:
        (downloads_dir / shard.filename).unlink(missing_ok=True)
        (downloads_dir / shard.filename).with_suffix(
            f"{Path(shard.filename).suffix}.partial"
        ).unlink(missing_ok=True)
    _remove_empty_directory(downloads_dir)


def _remove_empty_directory(path: Path) -> None:
    with suppress(FileNotFoundError, OSError):
        path.rmdir()


def _validate_source_id(value: str) -> str | None:
    if not value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 1 or path.name != value:
        raise ValueError(f"Unsafe source image identifier: {value!r}")
    return value


def _parse_args(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download and prepare the pinned Flickr8k dataset"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Settings.from_env().data_dir,
        help="Local output directory (default: %(default)s)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rebuild an existing prepared dataset",
    )
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    options = _parse_args(arguments)
    manifest = prepare_dataset(options.data_dir, force=options.force)
    LOGGER.info(
        "Prepared %s samples in %s",
        manifest["sample_count"],
        options.data_dir.expanduser().resolve(),
    )


if __name__ == "__main__":
    main()
