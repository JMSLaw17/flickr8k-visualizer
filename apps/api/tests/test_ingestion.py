from __future__ import annotations

import hashlib
import json
import sqlite3
from io import BytesIO
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as parquet
import pytest
from PIL import Image

from flickr8k_visualizer import ingestion as ingestion_module
from flickr8k_visualizer.config import REPOSITORY_ROOT
from flickr8k_visualizer.dataset_lock import (
    DatasetLock,
    DatasetShard,
    load_dataset_lock,
)
from flickr8k_visualizer.ingestion import (
    image_content_hash,
    ingest_downloaded_shards,
    parse_captions,
    parse_image_cell,
    prepare_dataset,
    read_image_metadata,
    stable_sample_id,
)

TRACKED_LOCK_PATH = REPOSITORY_ROOT / "datasets" / "flickr8k.lock.json"


def _jpeg_bytes(
    size: tuple[int, int] = (13, 7), *, orientation: int | None = None
) -> bytes:
    output = BytesIO()
    image = Image.new("RGB", size, color=(42, 91, 133))
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    image.save(output, format="JPEG", exif=exif)
    return output.getvalue()


def _write_fixture_parquet(path: Path, rows: list[dict[str, object]]) -> DatasetShard:
    schema = pa.schema(
        [
            pa.field(
                "image",
                pa.struct(
                    [pa.field("bytes", pa.binary()), pa.field("path", pa.string())]
                ),
            ),
            *(pa.field(f"caption_{index}", pa.string()) for index in range(5)),
        ]
    )
    parquet.write_table(pa.Table.from_pylist(rows, schema=schema), path)
    contents = path.read_bytes()
    return DatasetShard(
        split="train",
        repo_path=f"fixtures/{path.name}",
        size_bytes=len(contents),
        sha256=hashlib.sha256(contents).hexdigest(),
        row_count=len(rows),
    )


def test_tracked_dataset_lock_pins_the_expected_snapshot() -> None:
    dataset_lock = load_dataset_lock()

    assert TRACKED_LOCK_PATH.is_symlink()
    assert TRACKED_LOCK_PATH.is_file()
    assert dataset_lock.repo_id == "jxie/flickr8k"
    assert dataset_lock.revision == "56f58c967835f7c508d684f36bd7897cca9d7634"
    assert len(dataset_lock.shards) == 4
    assert sum(shard.row_count for shard in dataset_lock.shards) == 8_000
    assert {
        split: sum(
            shard.row_count for shard in dataset_lock.shards if shard.split == split
        )
        for split in {shard.split for shard in dataset_lock.shards}
    } == {"train": 6_000, "validation": 1_000, "test": 1_000}


def test_dataset_lock_requires_an_immutable_commit_revision(tmp_path: Path) -> None:
    lock_value = json.loads(TRACKED_LOCK_PATH.read_text(encoding="utf-8"))
    lock_value["revision"] = "main"
    lock_path = tmp_path / "flickr8k.lock.json"
    lock_path.write_text(json.dumps(lock_value), encoding="utf-8")

    with pytest.raises(RuntimeError, match="full 40-character commit SHA"):
        load_dataset_lock(lock_path)


def test_preparation_rejects_drift_from_the_tracked_lock(tmp_path: Path) -> None:
    dataset_lock = load_dataset_lock()
    data_dir = tmp_path / "prepared"
    data_dir.mkdir()
    shards = [
        {
            "path": shard.repo_path,
            "split": shard.split,
            "size_bytes": shard.size_bytes,
            "sha256": shard.sha256,
            "row_count": shard.row_count,
        }
        for shard in dataset_lock.shards
    ]
    shards[0]["sha256"] = "0" * 64
    manifest = {
        "dataset": {
            "repo_id": dataset_lock.repo_id,
            "revision": dataset_lock.revision,
        },
        "shards": shards,
    }
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(
        RuntimeError, match="does not match datasets/flickr8k.lock.json"
    ):
        prepare_dataset(data_dir)


def test_preparation_rejects_a_stale_ready_marker(tmp_path: Path) -> None:
    dataset_lock = load_dataset_lock()
    data_dir = tmp_path / "prepared"
    (data_dir / "images").mkdir(parents=True)
    (data_dir / "thumbnails").mkdir()
    (data_dir / "flickr8k.sqlite3").touch()
    manifest = {
        "dataset": {
            "repo_id": dataset_lock.repo_id,
            "revision": dataset_lock.revision,
        },
        "shards": [
            {
                "path": shard.repo_path,
                "split": shard.split,
                "size_bytes": shard.size_bytes,
                "sha256": shard.sha256,
                "row_count": shard.row_count,
            }
            for shard in dataset_lock.shards
        ],
    }
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (data_dir / ".ready").write_text(f"{'0' * 40}\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="ready marker does not match"):
        prepare_dataset(data_dir)


def test_stable_id_uses_source_identifier_not_content_or_row_order() -> None:
    source_id = "1000268201_693b08cb0e.jpg"

    assert stable_sample_id(source_id, "a" * 64) == "1000268201_693b08cb0e"
    assert stable_sample_id(source_id, "b" * 64) == "1000268201_693b08cb0e"
    assert stable_sample_id(None, "c" * 64) == f"sha256-{'c' * 64}"


def test_content_hash_uses_original_encoded_bytes() -> None:
    image_bytes = _jpeg_bytes()

    assert image_content_hash(image_bytes) == hashlib.sha256(image_bytes).hexdigest()
    assert image_content_hash(image_bytes + b"\0") != image_content_hash(image_bytes)


def test_metadata_parsers_preserve_caption_positions_and_source_id() -> None:
    image_bytes = _jpeg_bytes()
    record = {
        "caption_4": "fifth",
        "caption_1": " repeated ",
        "caption_0": "first",
        "caption_2": "repeated",
        "caption_3": "fourth",
        "unrelated": "ignored",
    }

    image = parse_image_cell(
        {"bytes": memoryview(image_bytes), "path": "1234567890_abcdef1234.jpg"}
    )
    metadata = read_image_metadata(image.data)

    assert image.source_id == "1234567890_abcdef1234.jpg"
    assert parse_captions(record) == [
        "first",
        " repeated ",
        "repeated",
        "fourth",
        "fifth",
    ]
    assert (metadata.width, metadata.height) == (13, 7)
    assert metadata.extension == "jpg"
    assert metadata.mime_type == "image/jpeg"


def test_ingestion_stores_exif_transposed_dimensions(tmp_path: Path) -> None:
    image_bytes = _jpeg_bytes(size=(13, 7), orientation=6)
    shard_path = tmp_path / "rotated.parquet"
    shard = _write_fixture_parquet(
        shard_path,
        [
            {
                "image": {"bytes": image_bytes, "path": "rotated.jpg"},
                **{f"caption_{index}": f"caption {index}" for index in range(5)},
            }
        ],
    )
    data_dir = tmp_path / "prepared"

    ingest_downloaded_shards(
        data_dir,
        {shard: shard_path},
        repo_id="fixture/flickr8k",
        revision="fixture-revision",
        delete_parquet=False,
    )

    with sqlite3.connect(data_dir / "flickr8k.sqlite3") as connection:
        stored = connection.execute(
            "SELECT width, height, content_sha256, original_path, thumbnail_path "
            "FROM samples WHERE id = ?",
            ("rotated",),
        ).fetchone()

    assert stored is not None
    width, height, content_sha256, original_path, thumbnail_path = stored
    assert (width, height) == (7, 13)
    assert content_sha256 == hashlib.sha256(image_bytes).hexdigest()
    assert (data_dir / original_path).read_bytes() == image_bytes
    with Image.open(data_dir / thumbnail_path) as thumbnail:
        assert thumbnail.size == (7, 13)


def test_image_parser_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="Unsafe source image identifier"):
        parse_image_cell({"bytes": _jpeg_bytes(), "path": "../image.jpg"})


def test_ingestion_builds_local_catalog_and_detects_duplicate_content(
    tmp_path: Path,
) -> None:
    image_bytes = _jpeg_bytes()
    rows = [
        {
            "image": {"bytes": image_bytes, "path": "1000000001_aaaaaaaaaa.jpg"},
            **{f"caption_{index}": f"first {index}" for index in range(5)},
        },
        {
            "image": {"bytes": image_bytes, "path": "1000000002_bbbbbbbbbb.jpg"},
            **{f"caption_{index}": "same" for index in range(5)},
        },
    ]
    shard_path = tmp_path / "train.parquet"
    shard = _write_fixture_parquet(shard_path, rows)
    data_dir = tmp_path / "prepared"

    manifest = ingest_downloaded_shards(
        data_dir,
        {shard: shard_path},
        repo_id="fixture/flickr8k",
        revision="fixture-revision",
        delete_parquet=True,
    )

    assert not shard_path.exists()
    assert manifest["sample_count"] == 2
    assert manifest["split_counts"] == {"train": 2}
    assert manifest["unique_image_count"] == 1
    assert manifest["duplicate_group_count"] == 1
    assert manifest["duplicate_sample_count"] == 1
    assert manifest["shards"][0]["split"] == "train"
    assert json.loads((data_dir / "manifest.json").read_text()) == manifest
    assert (data_dir / ".ready").read_text() == "fixture-revision\n"

    originals = list((data_dir / "images").rglob("*.jpg"))
    thumbnails = list((data_dir / "thumbnails").rglob("*.webp"))
    assert len(originals) == 1
    assert len(thumbnails) == 1
    assert originals[0].read_bytes() == image_bytes

    with sqlite3.connect(data_dir / "flickr8k.sqlite3") as connection:
        samples = connection.execute(
            """
            SELECT id, source_id, content_sha256, width, height,
                   original_path, thumbnail_path
            FROM samples ORDER BY id
            """
        ).fetchall()
        captions = connection.execute(
            "SELECT text FROM captions WHERE sample_id = ? ORDER BY position",
            ("1000000002_bbbbbbbbbb",),
        ).fetchall()
        duplicate_group = connection.execute(
            """
            SELECT duplicate_groups.content_sha256, duplicate_groups.sample_count
            FROM duplicate_groups
            """
        ).fetchone()
        duplicate_members = connection.execute(
            """
            SELECT samples.id
            FROM duplicate_groups
            JOIN samples USING (content_sha256)
            ORDER BY samples.id
            """
        ).fetchall()
        indexes = connection.execute("PRAGMA index_list('samples')").fetchall()
        hash_index_columns = connection.execute(
            "PRAGMA index_info('samples_content_sha256_idx')"
        ).fetchall()

    assert [sample[0] for sample in samples] == [
        "1000000001_aaaaaaaaaa",
        "1000000002_bbbbbbbbbb",
    ]
    assert samples[0][2] == samples[1][2] == image_content_hash(image_bytes)
    assert samples[0][3:5] == (13, 7)
    assert samples[0][5] == samples[1][5]
    assert samples[0][6] == samples[1][6]
    assert captions == [("same",)] * 5
    assert duplicate_group == (image_content_hash(image_bytes), 2)
    assert duplicate_members == [
        ("1000000001_aaaaaaaaaa",),
        ("1000000002_bbbbbbbbbb",),
    ]
    hash_index = next(row for row in indexes if row[1] == "samples_content_sha256_idx")
    assert hash_index[2] == 0
    assert [row[2] for row in hash_index_columns] == ["content_sha256"]


def test_failed_verification_keeps_source_parquet(tmp_path: Path) -> None:
    shard_path = tmp_path / "train.parquet"
    shard = _write_fixture_parquet(
        shard_path,
        [
            {
                "image": {
                    "bytes": _jpeg_bytes(),
                    "path": "1000000001_aaaaaaaaaa.jpg",
                },
                **{f"caption_{index}": f"caption {index}" for index in range(5)},
            }
        ],
    )
    invalid_shard = DatasetShard(
        split=shard.split,
        repo_path=shard.repo_path,
        size_bytes=shard.size_bytes,
        sha256="0" * 64,
        row_count=shard.row_count,
    )

    with pytest.raises(ValueError, match="Checksum verification failed"):
        ingest_downloaded_shards(
            tmp_path / "prepared",
            {invalid_shard: shard_path},
            repo_id="fixture/flickr8k",
            revision="fixture-revision",
            delete_parquet=True,
        )

    assert shard_path.exists()
    assert not (tmp_path / "prepared" / "manifest.json").exists()


def test_download_uses_a_sixty_second_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contents = b"fixture parquet"
    shard = DatasetShard(
        split="train",
        repo_path="data/train.parquet",
        size_bytes=len(contents),
        sha256=hashlib.sha256(contents).hexdigest(),
        row_count=1,
    )
    dataset_lock = DatasetLock(
        repo_id="fixture/flickr8k",
        revision="a" * 40,
        shards=(shard,),
    )
    observed_timeout: list[int] = []

    def fake_urlopen(_request: object, *, timeout: int) -> BytesIO:
        observed_timeout.append(timeout)
        return BytesIO(contents)

    monkeypatch.setattr(ingestion_module, "urlopen", fake_urlopen)
    downloads_dir = tmp_path / "downloads"
    downloads_dir.mkdir()

    downloaded_path = ingestion_module._download_shard(
        shard, downloads_dir, dataset_lock
    )

    assert observed_timeout == [60]
    assert downloaded_path.read_bytes() == contents
