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
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

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
from .download import download_verified_file, verify_file
from .fs import write_atomic
from .visual_search import (
    invalidate_visual_ready,
    prepare_visual_search,
    start_model_download,
)

LOGGER = logging.getLogger(__name__)

CAPTION_COLUMN = re.compile(r"^caption_(\d+)$")
THUMBNAIL_SIZE = (480, 480)
CAPTION_COLUMNS = [f"caption_{index}" for index in range(5)]
SHARD_COLUMNS = ["image", *CAPTION_COLUMNS]


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
    settings = Settings.for_data_dir(data_dir)
    data_dir = settings.data_dir
    manifest_path = settings.manifest_path
    database_path = settings.database_path
    ready_path = settings.ready_path
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
    settings = Settings.for_data_dir(data_dir)
    data_dir = settings.data_dir
    data_dir.mkdir(parents=True, exist_ok=True)

    for shard, shard_path in shard_paths.items():
        verify_file(shard_path, shard.size_bytes, shard.sha256)

    database_path = settings.database_path
    manifest_path = settings.manifest_path
    ready_path = settings.ready_path
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
        target = _IngestionTarget(data_dir, connection, split_counts, hash_counts)
        target.images_dir.mkdir(parents=True, exist_ok=True)
        target.thumbnails_dir.mkdir(parents=True, exist_ok=True)
        try:
            with connection:
                for shard, shard_path in shard_paths.items():
                    row_count = _ingest_shard(target, shard, shard_path)
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
        write_atomic(
            temporary_manifest_path,
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        )
        ready_path.unlink(missing_ok=True)
        # The new database has no clip_embeddings table, so any previously
        # published visual index no longer applies.
        invalidate_visual_ready(data_dir)
        os.replace(temporary_database_path, database_path)
        os.replace(temporary_manifest_path, manifest_path)
        write_atomic(ready_path, f"{revision}\n")

        if delete_parquet:
            for shard_path in shard_paths.values():
                shard_path.unlink(missing_ok=True)
            _remove_empty_directory(next(iter(shard_paths.values())).parent)

        return manifest
    except Exception:
        temporary_database_path.unlink(missing_ok=True)
        temporary_manifest_path.unlink(missing_ok=True)
        raise


@dataclass(frozen=True, slots=True)
class _IngestionTarget:
    """Where one ingestion run writes, plus its running tallies."""

    data_dir: Path
    connection: sqlite3.Connection
    split_counts: Counter[str]
    hash_counts: Counter[str]

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def thumbnails_dir(self) -> Path:
        return self.data_dir / "thumbnails"


def _ingest_shard(
    target: _IngestionTarget, shard: DatasetShard, shard_path: Path
) -> int:
    parquet_file = parquet.ParquetFile(shard_path)
    missing_columns = set(SHARD_COLUMNS) - set(parquet_file.schema_arrow.names)
    if missing_columns:
        raise ValueError(
            f"{shard.filename} is missing columns: {sorted(missing_columns)}"
        )

    row_count = 0
    # Encoding thumbnails is the slow part and each image is independent, so
    # images are written on every core while the database stays on this thread.
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 1) as pool:
        for batch in parquet_file.iter_batches(batch_size=64, columns=SHARD_COLUMNS):
            samples = [_parse_sample(record) for record in batch.to_pylist()]
            for _ in pool.map(lambda sample: _write_images(target, sample), samples):
                pass
            for sample in samples:
                _insert_sample(target, sample, shard.split)
            row_count += len(samples)

    target.split_counts[shard.split] += row_count
    LOGGER.info("Ingested %s rows from %s", row_count, shard.filename)
    return row_count


@dataclass(frozen=True, slots=True)
class _ParsedSample:
    image: ImagePayload
    captions: list[str]
    content_hash: str
    sample_id: str
    metadata: ImageMetadata


def _parse_sample(record: Mapping[str, object]) -> _ParsedSample:
    image = parse_image_cell(record.get("image"))
    captions = parse_captions(record)
    if not captions:
        raise ValueError("Sample does not contain a caption")

    content_hash = image_content_hash(image.data)
    return _ParsedSample(
        image=image,
        captions=captions,
        content_hash=content_hash,
        sample_id=stable_sample_id(image.source_id, content_hash),
        metadata=read_image_metadata(image.data),
    )


def _original_path(target: _IngestionTarget, sample: _ParsedSample) -> Path:
    return (
        target.images_dir
        / sample.content_hash[:2]
        / f"{sample.content_hash}.{sample.metadata.extension}"
    )


def _thumbnail_path(target: _IngestionTarget, sample: _ParsedSample) -> Path:
    return (
        target.thumbnails_dir / sample.content_hash[:2] / f"{sample.content_hash}.webp"
    )


def _write_images(target: _IngestionTarget, sample: _ParsedSample) -> None:
    _write_original_image(
        _original_path(target, sample), sample.image.data, sample.content_hash
    )
    _write_thumbnail(_thumbnail_path(target, sample), sample.image.data)


def _insert_sample(target: _IngestionTarget, sample: _ParsedSample, split: str) -> None:
    source_id = sample.image.source_id or f"sha256:{sample.content_hash}"
    try:
        target.connection.execute(
            """
            INSERT INTO samples (
                id, source_id, split, content_sha256, width, height,
                mime_type, file_size_bytes, original_path, thumbnail_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sample.sample_id,
                source_id,
                split,
                sample.content_hash,
                sample.metadata.width,
                sample.metadata.height,
                sample.metadata.mime_type,
                len(sample.image.data),
                _original_path(target, sample).relative_to(target.data_dir).as_posix(),
                _thumbnail_path(target, sample).relative_to(target.data_dir).as_posix(),
            ),
        )
    except sqlite3.IntegrityError as error:
        raise ValueError(f"Duplicate stable sample ID: {sample.sample_id}") from error

    target.connection.executemany(
        "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
        (
            (sample.sample_id, position, caption)
            for position, caption in enumerate(sample.captions)
        ),
    )
    target.hash_counts[sample.content_hash] += 1


def _write_original_image(path: Path, data: bytes, expected_hash: str) -> None:
    if path.is_file():
        if image_content_hash(path.read_bytes()) != expected_hash:
            raise ValueError(f"Existing image has unexpected content: {path}")
        return
    write_atomic(path, data)


def _write_thumbnail(path: Path, image_bytes: bytes) -> None:
    if path.is_file():
        return

    with Image.open(BytesIO(image_bytes)) as image:
        thumbnail = ImageOps.exif_transpose(image).convert("RGB")
        thumbnail.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
        encoded = BytesIO()
        # The default encoder effort; the slowest setting halves ingestion
        # speed for thumbnails about 4% smaller.
        thumbnail.save(encoded, format="WEBP", quality=82, method=4)
    write_atomic(path, encoded.getvalue())


def _download_shard(
    shard: DatasetShard, downloads_dir: Path, dataset_lock: DatasetLock
) -> Path:
    url = (
        f"https://huggingface.co/datasets/{dataset_lock.repo_id}/resolve/"
        f"{dataset_lock.revision}/{quote(shard.repo_path, safe='/')}?download=true"
    )
    return download_verified_file(
        url,
        downloads_dir / shard.filename,
        expected_size=shard.size_bytes,
        expected_hash=shard.sha256,
    )


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
        description="Download and prepare the pinned Flickr8k dataset "
        "and its visual search index"
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
    parser.add_argument(
        "--skip-visual",
        action="store_true",
        help="Prepare only the dataset; skip the visual search model and index",
    )
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    options = _parse_args(arguments)
    # The model depends on nothing the dataset stage produces, so its download
    # overlaps the shard downloads and ingestion.
    model_download = (
        None if options.skip_visual else start_model_download(options.data_dir)
    )
    manifest = prepare_dataset(options.data_dir, force=options.force)
    LOGGER.info(
        "Prepared %s samples in %s",
        manifest["sample_count"],
        options.data_dir.expanduser().resolve(),
    )
    if options.skip_visual:
        LOGGER.info(
            "Skipped visual search preparation; run again without --skip-visual "
            "to enable visual search"
        )
        return
    if model_download is not None:
        model_download.result()
    visual_manifest = prepare_visual_search(options.data_dir, force=options.force)
    LOGGER.info(
        "Visual search index covers %s samples", visual_manifest["sample_count"]
    )


if __name__ == "__main__":
    main()
